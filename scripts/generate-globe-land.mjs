#!/usr/bin/env node
// generate-globe-land.mjs — bakes the landing globe's land dots.
//
// The hero globe draws the continents as an ordered grid of dots: rows of
// latitude `step` degrees apart, each row holding as many evenly spaced dots
// as fit around the planet at that latitude (odd rows shifted half a step, so
// the grid packs like a honeycomb instead of stacking in columns). A dot is
// kept when it falls on land.
//
// Land comes from Natural Earth (public domain) via the world-atlas package's
// 1:50m TopoJSON. The browser never sees the polygons: this script scans each
// row against every coastline once and writes only the runs of land dots,
// run-length encoded, to src/components/landing/globe-land.ts. Two grids are
// baked: a fine one for large screens and a coarse one for phones, where the
// fine grid's dots would shrink to specks.
//
// Usage:
//   node scripts/generate-globe-land.mjs [path/to/land-50m.json]
// Without a path it downloads world-atlas@2/land-50m.json from jsDelivr.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Degrees between rows (and between dots along each row). */
const GRIDS = { fine: 1.2, coarse: 1.8 };
/** Northernmost and southernmost rows. */
const LAT_MAX = 84;
const LAT_MIN = -84;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'src/components/landing/globe-land.ts');

async function loadTopology() {
  const path = process.argv[2];
  if (path) return JSON.parse(readFileSync(path, 'utf8'));
  const url = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-50m.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** TopoJSON arcs are quantized and delta-encoded; returns them as [lng, lat] lists. */
function decodeArcs(topology) {
  const [sx, sy] = topology.transform.scale;
  const [tx, ty] = topology.transform.translate;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}

/** Every ring of the land geometry, as closed [lng, lat] lists. */
function landRings(topology) {
  const arcs = decodeArcs(topology);
  const ringFrom = (refs) => {
    const ring = [];
    refs.forEach((ref, i) => {
      const pts = ref >= 0 ? arcs[ref] : arcs[~ref].slice().reverse();
      ring.push(...(i === 0 ? pts : pts.slice(1)));
    });
    return ring;
  };
  const rings = [];
  const walk = (geometry) => {
    if (geometry.type === 'GeometryCollection') geometry.geometries.forEach(walk);
    else if (geometry.type === 'Polygon') geometry.arcs.forEach((r) => rings.push(ringFrom(r)));
    else if (geometry.type === 'MultiPolygon') geometry.arcs.forEach((p) => p.forEach((r) => rings.push(ringFrom(r))));
  };
  walk(topology.objects.land);
  return rings;
}

/**
 * Land intervals (in longitude) along one line of latitude: collect where
 * every coastline edge crosses the line, sort, and pair them up. Land
 * polygons never overlap, so even-odd across all rings is exact, holes
 * (large lakes) included.
 */
function landIntervals(rings, lat) {
  const xs = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j];
      const [bx, by] = ring[i];
      if (ay > lat !== by > lat) xs.push(ax + ((lat - ay) * (bx - ax)) / (by - ay));
    }
  }
  xs.sort((a, b) => a - b);
  const spans = [];
  for (let k = 0; k + 1 < xs.length; k += 2) spans.push([xs[k], xs[k + 1]]);
  return spans;
}

/**
 * One grid, encoded. Each row is "n:runs": its dot count n (stored, not
 * recomputed, so the browser never depends on its own Math.cos rounding the
 * same way Node's did) and its runs of land dots as base-36 start,length
 * pairs. Rows are separated by "|".
 */
function bake(rings, step) {
  const rows = [];
  let dots = 0;
  const rowCount = Math.floor((LAT_MAX - LAT_MIN) / step + 1e-9) + 1;
  for (let r = 0; r < rowCount; r++) {
    const lat = LAT_MAX - r * step;
    const n = Math.max(1, Math.round((360 * Math.cos((lat * Math.PI) / 180)) / step));
    const offset = (r % 2) * 0.5;
    const spans = landIntervals(rings, lat);
    const runs = [];
    let start = -1;
    for (let j = 0; j <= n; j++) {
      const lng = -180 + ((j + offset) * 360) / n;
      const land = j < n && spans.some(([a, b]) => lng >= a && lng <= b);
      if (land && start < 0) start = j;
      if (!land && start >= 0) {
        runs.push(start, j - start);
        dots += j - start;
        start = -1;
      }
    }
    rows.push(`${n.toString(36)}:${runs.map((v) => v.toString(36)).join(',')}`);
  }
  return { step, dots, encoded: rows.join('|') };
}

const topology = await loadTopology();
const rings = landRings(topology);
const grids = Object.fromEntries(Object.entries(GRIDS).map(([name, step]) => [name, bake(rings, step)]));

const body = Object.entries(grids)
  .map(
    ([name, g]) => `  ${name}: {
    step: ${g.step},
    count: ${g.dots},
    runs:
      '${g.encoded}',
  },`
  )
  .join('\n');

writeFileSync(
  out,
  `// GENERATED by scripts/generate-globe-land.mjs from Natural Earth 1:50m land
// (public domain, via world-atlas@2). Do not edit by hand; re-run the script.
//
// Each grid holds rows of latitude from LAND_LAT_MAX southward, \`step\`
// degrees apart. Row r is "n:runs": n dots, dot j at longitude
// -180 + (j + (r % 2) / 2) · 360 / n, and its runs of land dots as base-36
// "start,length" pairs. Rows are separated by "|".

export const LAND_LAT_MAX = ${LAT_MAX};

export type LandGrid = { step: number; count: number; runs: string };

export const LAND_GRIDS: Record<'fine' | 'coarse', LandGrid> = {
${body}
};
`
);
for (const [name, g] of Object.entries(grids)) {
  console.log(`${name}: ${g.step}° grid, ${g.dots} land dots, ${(g.encoded.length / 1024).toFixed(1)} KB`);
}
console.log(`${rings.length} coastline rings → ${out}`);
