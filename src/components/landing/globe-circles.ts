// globe-circles.ts — the savings circles the hero globe can name. Their
// names (CIRCLE_NAMES, below) also feed the hero's kinetic word and the
// tradition wall, so the landing page names the same traditions everywhere.
//
// Every name, alias and place here comes from the site's own vetted content:
// the /learn glossary (src/content/rosca-terms.ts) and the pillar guides for
// njangi, tontine and susu. Nothing is sourced from web lists of "the ROSCA
// name in every country", which copy each other's mistakes. The unit test in
// src/components/landing/__tests__/globe-circles.test.ts holds this file to
// those sources, so a name that leaves the glossary fails the build here too.
//
// Coordinates are a representative city in the region where the practice is
// native, not a claim that it belongs to that city. Places that share a
// country share a marker (Esusu and Ajo in Nigeria) so their markers never
// sit on top of each other.

export type GlobeTerm = {
  /** As a speaker of the language writes it. */
  name: string;
  /** Its page under /learn. */
  href: string;
  /** Other spellings and near-synonyms, shown as "Also called …". */
  aka: string[];
};

export type GlobeCircle = {
  id: string;
  lat: number;
  lng: number;
  /** ISO 3166-1 alpha-2 codes; the label localises them with Intl.DisplayNames. */
  countries: string[];
  terms: GlobeTerm[];
};

export const GLOBE_CIRCLES: GlobeCircle[] = [
  {
    id: 'njangi',
    lat: 5.96,
    lng: 10.15,
    countries: ['CM'],
    terms: [{ name: 'Njangi', href: '/learn/what-is-njangi', aka: ['Njangui'] }],
  },
  {
    id: 'tontine',
    lat: 14.69,
    lng: -17.44,
    countries: ['SN', 'ML', 'BF', 'CI'],
    terms: [{ name: 'Tontine', href: '/learn/tontine', aka: [] }],
  },
  {
    id: 'susu',
    lat: 5.6,
    lng: -0.19,
    countries: ['GH', 'SL'],
    terms: [{ name: 'Susu', href: '/learn/susu', aka: ['Osusu'] }],
  },
  {
    id: 'nigeria',
    lat: 7.2,
    lng: 3.6,
    countries: ['NG'],
    terms: [
      { name: 'Esusu', href: '/learn/esusu', aka: ['Isusu', 'Adashi'] },
      { name: 'Ajo', href: '/learn/ajo', aka: [] },
    ],
  },
  {
    id: 'gameya',
    lat: 30.04,
    lng: 31.24,
    countries: ['EG'],
    terms: [{ name: 'Gameya', href: '/learn/gameya', aka: ["Gam'iyya"] }],
  },
  {
    id: 'equb',
    lat: 9.03,
    lng: 38.74,
    countries: ['ET', 'ER'],
    terms: [{ name: 'Equb', href: '/learn/equb', aka: ['Iqub', 'Ekub'] }],
  },
  {
    id: 'hagbad',
    lat: 2.05,
    lng: 45.32,
    countries: ['SO'],
    terms: [{ name: 'Hagbad', href: '/learn/hagbad', aka: ['Ayuuto'] }],
  },
  {
    id: 'chama',
    lat: -1.29,
    lng: 36.82,
    countries: ['KE'],
    terms: [{ name: 'Chama', href: '/learn/chama', aka: ['Merry-go-round'] }],
  },
  {
    id: 'stokvel',
    lat: -26.2,
    lng: 28.05,
    countries: ['ZA'],
    terms: [{ name: 'Stokvel', href: '/learn/stokvel', aka: ['Umgalelo', 'Motshelo'] }],
  },
  {
    id: 'committee',
    lat: 31.55,
    lng: 74.34,
    countries: ['PK'],
    terms: [{ name: 'Committee', href: '/learn/committee', aka: ['Kameti', 'BC'] }],
  },
  {
    id: 'chit-fund',
    lat: 9.93,
    lng: 76.27,
    countries: ['IN'],
    terms: [{ name: 'Chit fund', href: '/learn/chit-fund', aka: ['Chitty', 'Kuri'] }],
  },
  {
    id: 'hui',
    lat: 24.48,
    lng: 118.09,
    countries: ['CN', 'TW', 'VN'],
    terms: [{ name: 'Hui', href: '/learn/hui', aka: ['Hụi'] }],
  },
  {
    id: 'kye',
    lat: 37.57,
    lng: 126.98,
    countries: ['KR'],
    terms: [{ name: 'Kye', href: '/learn/kye', aka: ['Gye'] }],
  },
  {
    id: 'paluwagan',
    lat: 14.6,
    lng: 120.98,
    countries: ['PH'],
    terms: [{ name: 'Paluwagan', href: '/learn/paluwagan', aka: [] }],
  },
  {
    id: 'arisan',
    lat: -6.2,
    lng: 106.85,
    countries: ['ID'],
    terms: [{ name: 'Arisan', href: '/learn/arisan', aka: [] }],
  },
  {
    id: 'tanda',
    lat: 19.43,
    lng: -99.13,
    countries: ['MX'],
    terms: [{ name: 'Tanda', href: '/learn/tanda', aka: [] }],
  },
  {
    id: 'cundina',
    lat: 25.69,
    lng: -100.32,
    countries: ['MX'],
    terms: [{ name: 'Cundina', href: '/learn/cundina', aka: [] }],
  },
  {
    id: 'pandero',
    lat: -12.05,
    lng: -77.04,
    countries: ['PE'],
    terms: [{ name: 'Pandero', href: '/learn/pandero', aka: ['Junta'] }],
  },
  {
    id: 'pardna',
    lat: 18.0,
    lng: -76.79,
    countries: ['JM'],
    terms: [{ name: 'Pardna', href: '/learn/pardna', aka: ['Partner'] }],
  },
  {
    id: 'sou-sou',
    lat: 10.65,
    lng: -61.52,
    countries: ['TT'],
    terms: [{ name: 'Sou-sou', href: '/learn/susu', aka: [] }],
  },
];

/**
 * Every name the globe can show, once each, in alphabetical order. Sorted by
 * plain code units rather than localeCompare, so the server and every browser
 * produce the same order and the hero hydrates without a mismatch.
 */
export const CIRCLE_NAMES: string[] = Array.from(
  new Set(GLOBE_CIRCLES.flatMap((circle) => circle.terms.map((term) => term.name)))
).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
