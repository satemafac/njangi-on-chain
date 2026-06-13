// GET /api/legal/doc?doc=terms|privacy|risk — serves the rendered legal
// document (both EN and FR) for in-app surfaces that cannot use
// getStaticProps, primarily the inline scrollable risk disclosure inside
// LegalAcceptanceModal. Public content (same as the /legal pages), so no
// auth; responses are cached in-process and at the edge.
//
// Source of truth: docs/legal-drafts/*.{en,fr}.md, parsed with the same
// dependency-free renderer the /legal pages use at build time.

import type { NextApiRequest, NextApiResponse } from 'next';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CURRENT_LEGAL_VERSIONS,
  isLegalDocId,
  parseLegalMarkdown,
  type LegalDocId,
  type LegalDocRender,
  type LegalLocale,
} from '../../../lib/legal-acceptance';

// Literal relative paths (not computed from the doc id) so file tracing on
// serverless bundlers can statically include every markdown source.
const SOURCE_FILES: Record<LegalDocId, Record<LegalLocale, string>> = {
  terms: {
    en: 'docs/legal-drafts/terms-of-service.en.md',
    fr: 'docs/legal-drafts/terms-of-service.fr.md',
  },
  privacy: {
    en: 'docs/legal-drafts/privacy-policy.en.md',
    fr: 'docs/legal-drafts/privacy-policy.fr.md',
  },
  risk: {
    en: 'docs/legal-drafts/risk-disclosure.en.md',
    fr: 'docs/legal-drafts/risk-disclosure.fr.md',
  },
};

type DocRenders = Record<LegalLocale, LegalDocRender>;

const renderCache = new Map<LegalDocId, DocRenders>();

async function loadDoc(doc: LegalDocId): Promise<DocRenders> {
  const cached = renderCache.get(doc);
  if (cached) return cached;

  const load = async (locale: LegalLocale): Promise<LegalDocRender> => {
    const raw = await readFile(path.join(process.cwd(), SOURCE_FILES[doc][locale]), 'utf8');
    return parseLegalMarkdown(raw);
  };
  const renders: DocRenders = { en: await load('en'), fr: await load('fr') };
  renderCache.set(doc, renders);
  return renders;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const doc = Array.isArray(req.query.doc) ? req.query.doc[0] : req.query.doc;
  if (!isLegalDocId(doc)) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_DOC',
      message: "Query parameter 'doc' must be one of: terms, privacy, risk.",
    });
  }

  try {
    const renders = await loadDoc(doc);
    // Static legal content — let clients and the CDN cache it briefly.
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    return res.status(200).json({
      success: true,
      doc,
      currentVersion: CURRENT_LEGAL_VERSIONS[doc],
      renders,
    });
  } catch (error) {
    console.error('[legal/doc] failed to load legal document', error);
    return res.status(500).json({
      success: false,
      error: 'DOC_LOAD_FAILED',
      message: 'Failed to load the legal document.',
    });
  }
}
