/**
 * The hero globe names savings circles by hovering the map. Those names are
 * public claims about other people's traditions, so they must come from the
 * site's vetted content — the /learn glossary and the pillar guides — and
 * never drift from it. This test holds globe-circles.ts to those sources, and
 * checks the baked land grids decode to what the generator promised.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

import { ROSCA_TERMS } from '@/content/rosca-terms';
import { GLOBE_CIRCLES } from '../globe-circles';
import { LAND_GRIDS } from '../globe-land';
import { decodeLandGrid, unitFromLatLng } from '../globe-geo';

const PILLAR_PAGES: Record<string, string> = {
  '/learn/what-is-njangi': 'src/pages/learn/what-is-njangi.tsx',
  '/learn/tontine': 'src/pages/learn/tontine.tsx',
  '/learn/susu': 'src/pages/learn/susu.tsx',
};
const pillarSource = (href: string) => readFileSync(resolve(process.cwd(), PILLAR_PAGES[href]), 'utf8');

const englishName = new Intl.DisplayNames(['en'], { type: 'region' });
/** How the sources write a few countries whose Intl name differs. */
const SOURCE_SPELLING: Record<string, string> = { KR: 'Korea', CI: 'Côte d', TT: 'Trinidad' };

describe('GLOBE_CIRCLES', () => {
  const terms = GLOBE_CIRCLES.flatMap((circle) => circle.terms.map((term) => ({ circle, term })));

  it.each(terms.map(({ circle, term }) => [term.name, circle.id, term] as const))(
    '%s (%s) matches its source',
    (_name, _id, term) => {
      if (term.href in PILLAR_PAGES) {
        const source = pillarSource(term.href);
        expect(source).toContain(term.name);
        term.aka.forEach((aka) => expect(source).toContain(aka));
        return;
      }
      const slug = term.href.replace(/^\/learn\//, '');
      const entry = ROSCA_TERMS.find((candidate) => candidate.slug === slug);
      expect(entry).toBeDefined();
      expect(term.name).toBe(entry!.term);
      term.aka.forEach((aka) => expect(entry!.alsoKnownAs).toContain(aka));
    }
  );

  it.each(GLOBE_CIRCLES.map((circle) => [circle.id, circle] as const))(
    '%s names only countries its sources name',
    (_id, circle) => {
      const sources = circle.terms
        .map((term) =>
          term.href in PILLAR_PAGES
            ? pillarSource(term.href)
            : ROSCA_TERMS.find((entry) => `/learn/${entry.slug}` === term.href)?.region ?? ''
        )
        .join('\n');
      circle.countries.forEach((code) => {
        const name = englishName.of(code);
        expect(name).toBeDefined();
        expect(name).not.toBe(code); // a real ISO 3166 region
        expect(sources).toContain(SOURCE_SPELLING[code] ?? name);
      });
    }
  );

  it('keeps every marker on the map and apart from the others', () => {
    const ids = new Set(GLOBE_CIRCLES.map((circle) => circle.id));
    expect(ids.size).toBe(GLOBE_CIRCLES.length);
    const dirs = GLOBE_CIRCLES.map((circle) => {
      expect(Math.abs(circle.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(circle.lng)).toBeLessThanOrEqual(180);
      const v = [0, 0, 0];
      unitFromLatLng(circle.lat, circle.lng, v);
      return v;
    });
    // At least 3° between markers, or their dots and labels collide.
    const minCos = Math.cos((3 * Math.PI) / 180);
    for (let i = 0; i < dirs.length; i++) {
      for (let j = i + 1; j < dirs.length; j++) {
        const dot = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1] + dirs[i][2] * dirs[j][2];
        expect(dot).toBeLessThan(minCos);
      }
    }
  });
});

describe('LAND_GRIDS', () => {
  it.each(Object.entries(LAND_GRIDS))('%s decodes to exactly its dot count, all on the unit sphere', (_name, grid) => {
    const dirs = decodeLandGrid(grid);
    expect(dirs.length).toBe(grid.count * 3);
    for (let i = 0; i < dirs.length; i += 3) {
      const length = Math.hypot(dirs[i], dirs[i + 1], dirs[i + 2]);
      expect(Math.abs(length - 1)).toBeLessThan(1e-5);
    }
  });

  it('puts land where the continents are, and none in mid-ocean', () => {
    const grid = LAND_GRIDS.fine;
    const dirs = decodeLandGrid(grid);
    const near = (lat: number, lng: number, degrees: number) => {
      const v = [0, 0, 0];
      unitFromLatLng(lat, lng, v);
      const minCos = Math.cos((degrees * Math.PI) / 180);
      for (let i = 0; i < dirs.length; i += 3) {
        if (dirs[i] * v[0] + dirs[i + 1] * v[1] + dirs[i + 2] * v[2] > minCos) return true;
      }
      return false;
    };
    // Yaoundé, Nairobi, Delhi, Mexico City, São Paulo: land within one step.
    [
      [3.87, 11.52],
      [-1.29, 36.82],
      [28.61, 77.21],
      [19.43, -99.13],
      [-23.55, -46.63],
    ].forEach(([lat, lng]) => expect(near(lat, lng, grid.step)).toBe(true));
    // Mid-Pacific, mid-Atlantic, the southern Indian Ocean.
    [
      [0, -150],
      [30, -40],
      [-40, 80],
    ].forEach(([lat, lng]) => expect(near(lat, lng, 5)).toBe(false));
  });
});
