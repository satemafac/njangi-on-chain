// globe-geo.ts — latitude/longitude ↔ the hero globe's local space, and the
// decoder for the baked land grids (see scripts/generate-globe-land.mjs).
//
// Convention (shared by the land dots, the markers and the hover pick): +Y is
// north, longitude 0 lies on +X, and longitude increases toward −Z.

import { LAND_LAT_MAX, type LandGrid } from './globe-land';

const DEG = Math.PI / 180;

/** Writes the unit vector for (lat, lng) into `out` at `offset`. */
export function unitFromLatLng(lat: number, lng: number, out: Float32Array | number[], offset = 0): void {
  const phi = (90 - lat) * DEG;
  const theta = (lng + 180) * DEG;
  out[offset] = -Math.sin(phi) * Math.cos(theta);
  out[offset + 1] = Math.cos(phi);
  out[offset + 2] = Math.sin(phi) * Math.sin(theta);
}

/** Unit vectors (x, y, z per dot) for every land dot in a baked grid. */
export function decodeLandGrid(grid: LandGrid): Float32Array {
  const out = new Float32Array(grid.count * 3);
  let k = 0;
  grid.runs.split('|').forEach((row, r) => {
    const [nPart, runsPart] = row.split(':');
    if (!runsPart) return;
    const n = parseInt(nPart, 36);
    const lat = LAND_LAT_MAX - r * grid.step;
    const offset = (r % 2) * 0.5;
    const runs = runsPart.split(',').map((v) => parseInt(v, 36));
    for (let i = 0; i + 1 < runs.length; i += 2) {
      for (let j = runs[i]; j < runs[i] + runs[i + 1]; j++) {
        unitFromLatLng(lat, -180 + ((j + offset) * 360) / n, out, k);
        k += 3;
      }
    }
  });
  return k === out.length ? out : out.subarray(0, k);
}
