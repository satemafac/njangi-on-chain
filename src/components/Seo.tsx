// Seo.tsx — the only place in this app that emits title / description /
// canonical / robots / Open Graph / Twitter / JSON-LD tags.
//
// EVERY tag below carries an explicit `key`. That is mandatory, not stylistic.
// next/head's dedup (node_modules/next/dist/shared/lib/head.js) only collapses:
//
//   <title> and <base>      by tag type, always
//   <meta name="...">       by the name value, AND ONLY IF THE TAG HAS NO KEY
//                           (the `metatype !== 'name' || !hasKey` guard)
//
// It does NOT dedup <meta property="og:...">, <link>, or <script> at all —
// `property` is absent from next/head's METATYPES list and <link>/<script> are
// not in its switch. Since _app.tsx and the page both render <Seo>, the key is
// the sole override mechanism for most of these tags.
//
// The corollary matters: a page must never leave a hand-rolled
// <meta name="description"> alongside <Seo>. The unkeyed page tag is kept (no
// key, and its name category is unseen) and the keyed _app tag is also kept
// (the key guard skips the name check), so you get two. That is precisely the
// duplication _document.tsx's comment records. If you need a tag Seo doesn't
// emit, pass it as a child WITH a key.
//
// Ordering is already correct: next/head reverses the collected children before
// the uniqueness pass, and _app mounts before the page, so page tags win.

import Head from 'next/head';
import type { ReactNode } from 'react';

import { SITE_NAME, SITE_URL, abs, graph, jsonLdProps, type JsonLd } from '@/lib/structured-data';

const TWITTER_HANDLE = '@njangi_on_chain';
const OG_LOCALE = 'en_US';

export const DEFAULT_TITLE = 'Njangi On-Chain — Rotating Savings Circles for the Diaspora';
export const DEFAULT_DESCRIPTION =
  'Njangi, tontine, susu, esusu — the rotating savings circle your community already runs, now self-custodied and verifiable. No treasurer, no seed phrase.';

export const DEFAULT_OG_IMAGE: SeoImage = {
  url: '/og.png?v=2',
  width: 1200,
  height: 630,
  type: 'image/png',
  alt: 'Njangi On-Chain — a 3D globe of diaspora savings circles linked across the world',
};

/**
 * Sitewide robots directives. max-image-preview:large is what lets Google use a
 * full-size thumbnail rather than a cropped one.
 */
const INDEXABLE_ROBOTS = [
  'index',
  'follow',
  'max-image-preview:large',
  'max-snippet:-1',
  'max-video-preview:-1',
];

export interface SeoImage {
  /** Absolute, or site-root-relative ("/og/faq.png"). Normalised via abs(). */
  url: string;
  width?: number;
  height?: number;
  /** Required — screen readers and LinkedIn/Slack both surface it. */
  alt: string;
  type?: string;
}

export interface SeoArticle {
  /** ISO 8601. */
  publishedTime: string;
  modifiedTime?: string;
  authorName?: string;
  section?: string;
  tags?: string[];
}

export interface SeoProps {
  title?: string;
  /** Skip the " | Njangi On-Chain" suffix, for titles that already carry the brand. */
  titleAbsolute?: boolean;
  description?: string;
  /** Site-root-relative path. Drives both canonical and og:url. */
  path?: `/${string}`;
  /** Full canonical override; wins over `path`. */
  canonical?: string;
  noindex?: boolean;
  nofollow?: boolean;
  ogType?: 'website' | 'article' | 'profile';
  /**
   * Social copy, when it should differ from the search copy. A SERP description
   * is budgeted at ~155 characters and answers a query; a share card has more
   * room and a different voice. Defaults to title/description.
   */
  ogTitle?: string;
  ogDescription?: string;
  image?: SeoImage;
  article?: SeoArticle;
  themeColor?: string;
  /** Page-level JSON-LD nodes, emitted as one @graph. */
  jsonLd?: JsonLd[];
  /** Site-level JSON-LD nodes. Set only by _app.tsx, in its own slot. */
  siteJsonLd?: JsonLd[];
  /** Escape hatch for tags Seo does not emit. Every child MUST carry a key. */
  children?: ReactNode;
}

export function Seo({
  title,
  titleAbsolute = false,
  description,
  path,
  canonical,
  noindex = false,
  nofollow = false,
  ogType = 'website',
  ogTitle,
  ogDescription,
  image,
  article,
  themeColor,
  jsonLd,
  siteJsonLd,
  children,
}: SeoProps) {
  const resolvedTitle = title
    ? titleAbsolute
      ? title
      : `${title} | ${SITE_NAME}`
    : DEFAULT_TITLE;
  const resolvedDescription = description ?? DEFAULT_DESCRIPTION;
  const url = canonical ?? (path ? `${SITE_URL}${path}` : undefined);
  const img = image ?? DEFAULT_OG_IMAGE;
  const imageUrl = abs(img.url);

  const robots =
    noindex || nofollow
      ? [noindex ? 'noindex' : 'index', nofollow ? 'nofollow' : 'follow'].join(', ')
      : INDEXABLE_ROBOTS.join(', ');

  return (
    <Head>
      <title key="seo:title">{resolvedTitle}</title>
      <meta key="seo:description" name="description" content={resolvedDescription} />
      <meta key="seo:robots" name="robots" content={robots} />
      {url && <link key="seo:canonical" rel="canonical" href={url} />}

      <meta key="seo:og:site_name" property="og:site_name" content={SITE_NAME} />
      <meta key="seo:og:locale" property="og:locale" content={OG_LOCALE} />
      <meta key="seo:og:type" property="og:type" content={ogType} />
      <meta key="seo:og:title" property="og:title" content={ogTitle ?? resolvedTitle} />
      <meta
        key="seo:og:description"
        property="og:description"
        content={ogDescription ?? resolvedDescription}
      />
      {url && <meta key="seo:og:url" property="og:url" content={url} />}
      <meta key="seo:og:image" property="og:image" content={imageUrl} />
      <meta key="seo:og:image:secure" property="og:image:secure_url" content={imageUrl} />
      <meta key="seo:og:image:w" property="og:image:width" content={String(img.width ?? 1200)} />
      <meta key="seo:og:image:h" property="og:image:height" content={String(img.height ?? 630)} />
      <meta key="seo:og:image:alt" property="og:image:alt" content={img.alt} />
      {img.type && <meta key="seo:og:image:type" property="og:image:type" content={img.type} />}

      {/* twitter:* uses name=, which is what the card spec defines. property=
          only works because Twitter's parser is lenient; the codebase used to
          mix both forms across pages. */}
      <meta key="seo:tw:card" name="twitter:card" content="summary_large_image" />
      <meta key="seo:tw:site" name="twitter:site" content={TWITTER_HANDLE} />
      <meta key="seo:tw:creator" name="twitter:creator" content={TWITTER_HANDLE} />
      <meta key="seo:tw:title" name="twitter:title" content={ogTitle ?? resolvedTitle} />
      <meta
        key="seo:tw:description"
        name="twitter:description"
        content={ogDescription ?? resolvedDescription}
      />
      <meta key="seo:tw:image" name="twitter:image" content={imageUrl} />
      <meta key="seo:tw:image:alt" name="twitter:image:alt" content={img.alt} />

      {article && (
        <>
          <meta
            key="seo:art:published"
            property="article:published_time"
            content={article.publishedTime}
          />
          {article.modifiedTime && (
            <meta
              key="seo:art:modified"
              property="article:modified_time"
              content={article.modifiedTime}
            />
          )}
          {article.authorName && (
            <meta key="seo:art:author" property="article:author" content={article.authorName} />
          )}
          {article.section && (
            <meta key="seo:art:section" property="article:section" content={article.section} />
          )}
          {article.tags?.map((tag) => (
            <meta key={`seo:art:tag:${tag}`} property="article:tag" content={tag} />
          ))}
        </>
      )}

      {themeColor && <meta key="seo:theme-color" name="theme-color" content={themeColor} />}

      {/* Two slots, not one. A single key would make a page's graph *replace*
          the sitewide Organization node rather than sit alongside it. */}
      {siteJsonLd?.length ? (
        <script key="seo:jsonld:site" {...jsonLdProps(graph(siteJsonLd))} />
      ) : null}
      {jsonLd?.length ? <script key="seo:jsonld:page" {...jsonLdProps(graph(jsonLd))} /> : null}

      {children}
    </Head>
  );
}

export default Seo;
