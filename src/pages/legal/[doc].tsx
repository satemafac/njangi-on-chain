// /legal/[doc] — Statically generated legal document pages (terms, privacy,
// risk). Content source of truth: docs/legal-drafts/*.{en,fr}.md, rendered to
// HTML at build time via the dependency-free renderer in
// src/lib/legal-acceptance.ts.
//
// The DRAFT banner must remain visible until qualified counsel signs off on
// the documents (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md).

import { useEffect, useMemo, useState } from 'react';
import type { GetStaticPaths, GetStaticProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Manrope } from 'next/font/google';
import {
  CURRENT_LEGAL_VERSIONS,
  LEGAL_DOC_IDS,
  LEGAL_DOC_LABELS,
  LEGAL_DOC_ROUTES,
  LEGAL_DOC_SOURCE_BASENAMES,
  LEGAL_DRAFT_NOTICE,
  formatEffectiveDate,
  isLegalLocale,
  parseLegalMarkdown,
  type LegalDocId,
  type LegalDocRender,
  type LegalLocale,
} from '../../lib/legal-acceptance';
import { getLocale, setLocale } from '../../lib/i18n';
import { LegalFooter } from '../../components/LegalFooter';

const bodyFont = Manrope({ subsets: ['latin'], display: 'swap' });

interface LegalDocPageProps {
  doc: LegalDocId;
  renders: Record<LegalLocale, LegalDocRender>;
}

// Scoped styles for the rendered markdown. Inlined (instead of styled-jsx or
// a typography plugin) to keep the page self-contained and type-check clean.
const LEGAL_DOC_CSS = `
.legal-doc { color: #374151; font-size: 0.95rem; line-height: 1.7; }
.legal-doc h1 { color: #111827; font-size: 1.65rem; line-height: 1.25; font-weight: 700; margin: 1.75rem 0 0.75rem; letter-spacing: -0.02em; }
.legal-doc h2 { color: #111827; font-size: 1.2rem; font-weight: 700; margin: 2rem 0 0.65rem; letter-spacing: -0.01em; }
.legal-doc h3 { color: #111827; font-size: 1.05rem; font-weight: 600; margin: 1.5rem 0 0.5rem; }
.legal-doc p { margin: 0.7rem 0; }
.legal-doc ul, .legal-doc ol { margin: 0.7rem 0 0.7rem 1.4rem; display: grid; gap: 0.35rem; }
.legal-doc ul { list-style: disc; }
.legal-doc ol { list-style: decimal; }
.legal-doc blockquote { border-left: 3px solid #d97706; background: #fffbeb; color: #92400e; padding: 0.75rem 1rem; border-radius: 0 0.5rem 0.5rem 0; margin: 1rem 0; font-size: 0.9rem; }
.legal-doc blockquote p { margin: 0.25rem 0; }
.legal-doc code { background: #f1ece4; border: 1px solid #e6ddd1; border-radius: 0.3rem; padding: 0.05rem 0.35rem; font-size: 0.85em; color: #1f2937; }
.legal-doc strong { color: #111827; font-weight: 700; }
.legal-doc table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.85rem; display: block; overflow-x: auto; }
.legal-doc th, .legal-doc td { border: 1px solid #e6ddd1; padding: 0.5rem 0.65rem; text-align: left; vertical-align: top; }
.legal-doc th { background: #f1ece4; color: #111827; font-weight: 600; }
`;

const UI_STRINGS: Record<
  LegalLocale,
  {
    home: string;
    version: string;
    effective: string;
    otherDocs: string;
    languageLabel: string;
    versionNote: (requested: string, current: string) => string;
  }
> = {
  en: {
    home: 'Home',
    version: 'Version',
    effective: 'Effective date',
    otherDocs: 'Legal documents',
    languageLabel: 'Document language',
    versionNote: (requested, current) =>
      `Version ${requested} is not published. Showing the current version (${current}).`,
  },
  fr: {
    home: 'Accueil',
    version: 'Version',
    effective: "Date d'entrée en vigueur",
    otherDocs: 'Documents juridiques',
    languageLabel: 'Langue du document',
    versionNote: (requested, current) =>
      `La version ${requested} n'est pas publiée. Affichage de la version actuelle (${current}).`,
  },
};

export default function LegalDocPage({ doc, renders }: LegalDocPageProps) {
  const router = useRouter();
  const [lang, setLang] = useState<LegalLocale>('en');

  // Default language: explicit ?lang= wins, then the app-wide locale stored
  // by src/lib/i18n.ts (only en/fr are published legal languages).
  useEffect(() => {
    if (!router.isReady) return;
    const queryLang = router.query.lang;
    if (isLegalLocale(queryLang)) {
      setLang(queryLang);
      return;
    }
    const appLocale = getLocale();
    if (isLegalLocale(appLocale)) {
      setLang(appLocale);
    }
  }, [router.isReady, router.query.lang]);

  const switchLang = (next: LegalLocale) => {
    setLang(next);
    // Persist the reader's choice app-wide (localStorage 'njangi.locale').
    setLocale(next);
    void router.replace(
      { pathname: router.pathname, query: { ...router.query, lang: next } },
      undefined,
      { shallow: true },
    );
  };

  const render = renders[lang];
  const ui = UI_STRINGS[lang];
  const draft = LEGAL_DRAFT_NOTICE[lang];
  const currentVersion = CURRENT_LEGAL_VERSIONS[doc];

  const requestedVersion = useMemo(() => {
    const v = router.query.version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  }, [router.query.version]);

  return (
    <>
      <Head>
        <title>{`${LEGAL_DOC_LABELS.en[doc]} | Njangi On-Chain`}</title>
        <meta
          name="description"
          content={`${LEGAL_DOC_LABELS.en[doc]} for Njangi On-Chain (version ${currentVersion}, draft pending counsel review). Available in English and French.`}
        />
        <link rel="canonical" href={`https://njangionchain.com${LEGAL_DOC_ROUTES[doc]}`} />
      </Head>
      <style dangerouslySetInnerHTML={{ __html: LEGAL_DOC_CSS }} />

      <div className={`${bodyFont.className} min-h-screen bg-[#f6f2ea] text-[#374151]`}>
        <header className="border-b border-[#e6ddd1] bg-[#f1ece4]/80">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
            <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" aria-label={ui.otherDocs}>
              <Link href="/" className="font-semibold text-[#111827] hover:underline">
                {ui.home}
              </Link>
              {LEGAL_DOC_IDS.map((id) => (
                <Link
                  key={id}
                  href={LEGAL_DOC_ROUTES[id]}
                  aria-current={id === doc ? 'page' : undefined}
                  className={
                    id === doc
                      ? 'rounded-full border border-[#ddd5ca] bg-white px-3 py-1 font-semibold text-[#111827]'
                      : 'text-[#556070] hover:text-[#111827] hover:underline'
                  }
                >
                  {LEGAL_DOC_LABELS[lang][id]}
                </Link>
              ))}
            </nav>

            <div
              className="inline-flex overflow-hidden rounded-full border border-[#ddd5ca] bg-white text-xs font-semibold"
              role="group"
              aria-label={ui.languageLabel}
            >
              {(['en', 'fr'] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => switchLang(code)}
                  aria-pressed={lang === code}
                  className={
                    lang === code
                      ? 'bg-[#111827] px-3 py-1.5 text-white'
                      : 'px-3 py-1.5 text-[#556070] hover:text-[#111827]'
                  }
                >
                  {code.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
          {/* DRAFT banner — must remain until counsel signs off. */}
          <div
            role="status"
            className="mb-6 flex items-start gap-3 rounded-xl border border-amber-400 bg-amber-50 p-4 text-amber-900"
          >
            <span className="mt-0.5 shrink-0 rounded-md bg-amber-500 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white">
              {draft.badge}
            </span>
            <p className="text-sm leading-relaxed">{draft.body}</p>
          </div>

          {requestedVersion && requestedVersion !== render.version ? (
            <p className="mb-4 rounded-lg border border-[#ddd5ca] bg-white px-4 py-2 text-sm text-[#556070]">
              {ui.versionNote(requestedVersion, render.version)}
            </p>
          ) : null}

          <div className="rounded-2xl border border-[#e6ddd1] bg-[#fbfaf7] p-6 sm:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#65748b]">
              {render.title}
            </p>
            <p className="mt-2 text-sm text-[#6b7280]">
              {ui.version} {render.version} · {ui.effective}:{' '}
              {formatEffectiveDate(render.effectiveDate, lang)}
            </p>

            <article
              lang={lang}
              className="legal-doc mt-4"
              dangerouslySetInnerHTML={{ __html: render.html }}
            />
          </div>

          <div className="mt-8 border-t border-[#ddd5c9] pt-4">
            <LegalFooter />
          </div>
        </main>
      </div>
    </>
  );
}

export const getStaticPaths: GetStaticPaths = async () => ({
  paths: LEGAL_DOC_IDS.map((doc) => ({ params: { doc } })),
  fallback: false,
});

export const getStaticProps: GetStaticProps<LegalDocPageProps> = async ({ params }) => {
  const doc = params?.doc as LegalDocId;
  // node imports stay inside getStaticProps so the client bundle never sees fs.
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');

  const basename = LEGAL_DOC_SOURCE_BASENAMES[doc];
  const load = async (locale: LegalLocale): Promise<LegalDocRender> => {
    const file = path.join(process.cwd(), 'docs', 'legal-drafts', `${basename}.${locale}.md`);
    const raw = await readFile(file, 'utf8');
    const render = parseLegalMarkdown(raw);
    if (render.version !== CURRENT_LEGAL_VERSIONS[doc]) {
      throw new Error(
        `[legal] ${basename}.${locale}.md frontmatter version ${render.version} does not match ` +
          `CURRENT_LEGAL_VERSIONS.${doc} (${CURRENT_LEGAL_VERSIONS[doc]}). Update src/lib/legal-acceptance.ts.`,
      );
    }
    return render;
  };

  return {
    props: {
      doc,
      renders: { en: await load('en'), fr: await load('fr') },
    },
  };
};
