// structured-data.ts — typed schema.org JSON-LD builders.
//
// One module so every page emits the same entity graph instead of hand-rolled
// object literals drifting apart. Nodes are linked by @id (Organization <->
// WebSite <-> WebPage), which is how Google resolves them into a single site
// entity rather than several unrelated ones.
//
// What this actually buys, honestly:
//   WebSite.name        controls the site name shown above a result. Without it
//                       Google falls back to the bare domain, which is why the
//                       SERP has been reading "njangionchain.com".
//   BreadcrumbList      renders the breadcrumb trail in place of the raw URL.
//   Organization.logo   feeds the knowledge panel and the result thumbnail.
//   Article             eligibility for Top Stories / Discover surfaces.
//   FAQPage             entity understanding only — Google restricted FAQ rich
//                       results to government and health sites in Aug 2023, so
//                       do not expect visible accordions from this.

import { getCanonicalBaseOrigin } from './canonical-host';
import { SUPPORT_EMAIL } from './constants';

export const SITE_URL = getCanonicalBaseOrigin() ?? 'https://njangionchain.com';
export const SITE_NAME = 'Njangi On-Chain';

/** Variants people actually type. Feeds WebSite.alternateName. */
export const SITE_ALTERNATE_NAMES = ['Njangi', 'Njangi OnChain', 'NjangiOnChain'];

export const SOCIAL_PROFILES = [
  'https://x.com/njangi_on_chain',
  'https://www.instagram.com/njangionchain',
];

const ORGANIZATION_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;

/**
 * Square, opaque, tightly cropped. The old value pointed at
 * njangi-on-chain-logo.png — 2464x1536 with the mark occupying only 1054x1070 of
 * the canvas, on transparency — so Google squared it, composited it on white, and
 * rendered a small badge adrift in an empty tile.
 */
export const LOGO_URL = `${SITE_URL}/brand/logo-square-512.png`;

export type JsonLd = Record<string, unknown>;

/** Resolve a site-relative path to the absolute URL schema.org requires. */
export function abs(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export function organization(): JsonLd {
  return {
    '@type': 'Organization',
    '@id': ORGANIZATION_ID,
    name: SITE_NAME,
    alternateName: SITE_ALTERNATE_NAMES,
    url: `${SITE_URL}/`,
    logo: {
      '@type': 'ImageObject',
      '@id': `${SITE_URL}/#logo`,
      url: LOGO_URL,
      contentUrl: LOGO_URL,
      width: 512,
      height: 512,
      caption: SITE_NAME,
    },
    image: { '@id': `${SITE_URL}/#logo` },
    description:
      'Coordination software for rotating savings circles. Members contribute on a shared schedule and each receives the pooled amount in turn.',
    foundingDate: '2024',
    sameAs: SOCIAL_PROFILES,
    contactPoint: {
      '@type': 'ContactPoint',
      email: SUPPORT_EMAIL,
      contactType: 'Customer Service',
      availableLanguage: ['en', 'fr'],
    },
  };
}

/**
 * The lever for the site-name line in a search result. Google reads
 * WebSite.name from the home page specifically, so this node belongs on `/`.
 */
export function website(): JsonLd {
  return {
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    name: SITE_NAME,
    alternateName: SITE_ALTERNATE_NAMES,
    url: `${SITE_URL}/`,
    publisher: { '@id': ORGANIZATION_ID },
    inLanguage: 'en',
  };
}

export function webApplication(): JsonLd {
  return {
    '@type': 'WebApplication',
    '@id': `${SITE_URL}/#webapp`,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Web',
    description:
      'Run a njangi, tontine, susu or esusu with the contribution schedule, payout order, and full history visible to every member.',
    publisher: { '@id': ORGANIZATION_ID },
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: 'Free plan for small circles; Premium subscription for coordination features.',
    },
    featureList: [
      'Shared circle visibility',
      'Direct on-chain settlement',
      'zkLogin sign-in with no wallet setup',
      'Multi-asset contributions',
      'Auditable contribution and payout history',
    ],
  };
}

export interface BreadcrumbItem {
  name: string;
  /** Site-relative path. Omit on the final crumb — the current page. */
  path?: string;
}

export function breadcrumbs(items: BreadcrumbItem[]): JsonLd {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      ...(item.path ? { item: abs(item.path) } : {}),
    })),
  };
}

export interface ArticleInput {
  headline: string;
  description: string;
  path: string;
  image?: string;
  /** ISO 8601. */
  datePublished: string;
  dateModified?: string;
  section?: string;
  keywords?: string[];
}

export function article(input: ArticleInput): JsonLd {
  return {
    '@type': 'Article',
    headline: input.headline,
    description: input.description,
    mainEntityOfPage: { '@type': 'WebPage', '@id': abs(input.path) },
    url: abs(input.path),
    ...(input.image ? { image: [abs(input.image)] } : {}),
    datePublished: input.datePublished,
    dateModified: input.dateModified ?? input.datePublished,
    author: { '@id': ORGANIZATION_ID },
    publisher: { '@id': ORGANIZATION_ID },
    ...(input.section ? { articleSection: input.section } : {}),
    ...(input.keywords?.length ? { keywords: input.keywords.join(', ') } : {}),
    inLanguage: 'en',
  };
}

export interface FaqItem {
  question: string;
  answer: string;
}

export function faqPage(items: FaqItem[]): JsonLd {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

export interface DefinedTermInput {
  name: string;
  description: string;
  path: string;
  /** Other names for the same practice. */
  alternateNames?: string[];
  termSetPath?: string;
}

export function definedTerm(input: DefinedTermInput): JsonLd {
  return {
    '@type': 'DefinedTerm',
    name: input.name,
    description: input.description,
    url: abs(input.path),
    ...(input.alternateNames?.length ? { alternateName: input.alternateNames } : {}),
    ...(input.termSetPath
      ? {
          inDefinedTermSet: {
            '@type': 'DefinedTermSet',
            '@id': abs(input.termSetPath),
            name: 'Rotating savings circles around the world',
            url: abs(input.termSetPath),
          },
        }
      : {}),
  };
}

export function definedTermSet(path: string, terms: DefinedTermInput[]): JsonLd {
  return {
    '@type': 'DefinedTermSet',
    '@id': abs(path),
    name: 'Rotating savings circles around the world',
    description:
      'The same rotating savings practice as it is named and run across Africa, Asia, Latin America, and the Caribbean.',
    url: abs(path),
    hasDefinedTerm: terms.map((term) => ({
      '@type': 'DefinedTerm',
      name: term.name,
      description: term.description,
      url: abs(term.path),
      ...(term.alternateNames?.length ? { alternateName: term.alternateNames } : {}),
    })),
  };
}

/**
 * Wrap nodes into a single @graph. One script tag per page beats several
 * disconnected ones: it lets the @id references above actually resolve.
 */
export function graph(nodes: JsonLd[]): JsonLd {
  return { '@context': 'https://schema.org', '@graph': nodes };
}

/**
 * Props for a <script type="application/ld+json">. JSON.stringify already
 * escapes nothing dangerous here (all inputs are our own strings), but `<` is
 * escaped anyway so a stray "</script>" in future copy cannot break out.
 */
export function jsonLdProps(node: JsonLd) {
  return {
    type: 'application/ld+json',
    dangerouslySetInnerHTML: {
      __html: JSON.stringify(node).replace(/</g, '\\u003c'),
    },
  };
}
