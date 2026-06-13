// legal-acceptance.ts — Shared constants + markdown rendering for the legal
// surface (June 2026 GTM readiness; see docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md).
//
// Source of truth for the documents is docs/legal-drafts/*.{en,fr}.md. This
// module is deliberately **client-safe** (no node imports): the pages under
// src/pages/legal/ read the markdown with `fs` inside getStaticProps and feed
// it through `parseLegalMarkdown` at build time, while client components
// (footer, acceptance modal) import only the constants below.
//
// Versioning: bumping a version here + adding the new markdown file is the
// whole release procedure for a new document version. The server always
// resolves versions from CURRENT_LEGAL_VERSIONS — never from client input.

export const LEGAL_DOC_IDS = ['terms', 'privacy', 'risk'] as const;
export type LegalDocId = (typeof LEGAL_DOC_IDS)[number];

export type LegalLocale = 'en' | 'fr';
export const LEGAL_LOCALES: LegalLocale[] = ['en', 'fr'];

export function isLegalDocId(value: unknown): value is LegalDocId {
  return typeof value === 'string' && (LEGAL_DOC_IDS as readonly string[]).includes(value);
}

export function isLegalLocale(value: unknown): value is LegalLocale {
  return value === 'en' || value === 'fr';
}

/**
 * Current published version per document. The acceptance gate compares a
 * user's latest accepted version against this map; the legal pages render
 * the matching markdown file.
 */
export const CURRENT_LEGAL_VERSIONS: Record<LegalDocId, string> = {
  terms: '1.0.0',
  privacy: '1.0.0',
  risk: '1.0.0',
};

/** Markdown basenames inside docs/legal-drafts (suffix `.{en,fr}.md`). */
export const LEGAL_DOC_SOURCE_BASENAMES: Record<LegalDocId, string> = {
  terms: 'terms-of-service',
  privacy: 'privacy-policy',
  risk: 'risk-disclosure',
};

export const LEGAL_DOC_ROUTES: Record<LegalDocId, string> = {
  terms: '/legal/terms',
  privacy: '/legal/privacy',
  risk: '/legal/risk',
};

export const LEGAL_DOC_LABELS: Record<LegalLocale, Record<LegalDocId, string>> = {
  en: {
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    risk: 'Risk Disclosure',
  },
  fr: {
    terms: "Conditions Générales d'Utilisation",
    privacy: 'Politique de Confidentialité',
    risk: 'Information sur les Risques',
  },
};

/**
 * The rendered pages must keep a prominent DRAFT banner until counsel signs
 * off on the documents. Do not remove this notice as part of a UI cleanup —
 * removal is a legal decision, not a design one.
 */
export const LEGAL_DRAFT_NOTICE: Record<LegalLocale, { badge: string; body: string }> = {
  en: {
    badge: 'DRAFT',
    body: 'This document is a draft pending review by qualified counsel. It is published for transparency and is not yet in force.',
  },
  fr: {
    badge: 'PROJET',
    body: "Ce document est un projet en attente de revue par un conseil juridique qualifié. Il est publié à titre de transparence et n'est pas encore en vigueur.",
  },
};

/**
 * Routes the acceptance gate must NEVER block (mirror of the "recovery is
 * never paywalled" rule in docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md):
 *
 *  - `/auth`   — the login/callback flow itself (the gate runs after it);
 *  - `/legal`  — users must be able to read the documents they are accepting;
 *  - `/circle` — claim_payout, recovery proposals/votes/execution, and refund
 *    flows all live under /circle/[id]/**. A read-only legal hold must never
 *    lock funds access, so a user deep-linking to a recovery/claim route is
 *    always let through even with outstanding acceptances.
 *
 * Matched against `router.pathname`, so both the route pattern
 * (`/circle/[id]`) and concrete asPath forms are covered by the prefix.
 */
export const LEGAL_GATE_EXEMPT_PATH_PREFIXES = ['/auth', '/legal', '/circle'] as const;

export function isLegalGateExemptPath(pathname: string): boolean {
  return LEGAL_GATE_EXEMPT_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Renders the frontmatter effective_date, mapping unresolved placeholders. */
export function formatEffectiveDate(value: string | undefined, locale: LegalLocale): string {
  if (!value || /\{\{.*\}\}/.test(value)) {
    return locale === 'fr' ? 'à déterminer (projet)' : 'to be announced (draft)';
  }
  return value;
}

export interface LegalDocRender {
  title: string;
  version: string;
  effectiveDate: string;
  language: string;
  html: string;
}

// ---------------------------------------------------------------------------
// Tiny markdown renderer
//
// The legal drafts use a small, known subset of markdown: frontmatter,
// headings, blockquotes, bold, inline code, unordered/ordered lists, tables,
// and paragraphs. A ~100-line renderer keeps us off a heavy markdown
// dependency (none exists in package.json) and produces deterministic,
// fully-escaped HTML at build time.
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return out;
}

interface FrontmatterSplit {
  meta: Record<string, string>;
  body: string;
}

export function parseFrontmatter(raw: string): FrontmatterSplit {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { meta: {}, body: raw };
  }
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body: raw.slice(match[0].length) };
}

const TABLE_SEPARATOR = /^\|?[\s:-]+\|[\s|:-]*$/;

function renderTable(rows: string[]): string {
  const parseRow = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => renderInline(cell.trim()));

  const [headerRow, ...rest] = rows;
  const bodyRows = rest.filter((row) => !TABLE_SEPARATOR.test(row.trim()));
  const header = parseRow(headerRow)
    .map((cell) => `<th>${cell}</th>`)
    .join('');
  const body = bodyRows
    .map((row) => `<tr>${parseRow(row).map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderLegalMarkdownBody(body: string): string {
  const lines = body.split(/\r?\n/);
  const html: string[] = [];
  let i = 0;

  const isBlockBoundary = (line: string): boolean =>
    !line.trim() ||
    /^#{1,6}\s/.test(line) ||
    line.startsWith('>') ||
    /^\s*-\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    line.trimStart().startsWith('|');

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        const content = lines[i].replace(/^>\s?/, '').trim();
        if (content) quoteLines.push(`<p>${renderInline(content)}</p>`);
        i += 1;
      }
      html.push(`<blockquote>${quoteLines.join('')}</blockquote>`);
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*-\s+/, '').trim())}</li>`);
        i += 1;
      }
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, '').trim())}</li>`);
        i += 1;
      }
      html.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    if (line.trimStart().startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        rows.push(lines[i]);
        i += 1;
      }
      html.push(renderTable(rows));
      continue;
    }

    // Paragraph: accumulate until a blank line or the next block construct.
    const paragraph: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlockBoundary(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }

  return html.join('\n');
}

/** Parses a docs/legal-drafts markdown file into metadata + rendered HTML. */
export function parseLegalMarkdown(raw: string): LegalDocRender {
  const { meta, body } = parseFrontmatter(raw);
  return {
    title: meta.title ?? '',
    version: meta.version ?? '',
    effectiveDate: meta.effective_date ?? '',
    language: meta.language ?? '',
    html: renderLegalMarkdownBody(body),
  };
}
