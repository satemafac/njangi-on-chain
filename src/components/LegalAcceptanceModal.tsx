// LegalAcceptanceModal — blocking legal acceptance gate
// (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md "UX" / "When the gate triggers").
//
// Two exports:
//  * LegalAcceptanceGate — mounted once inside AuthProvider. After
//    authentication it checks GET /api/legal/status and renders the modal
//    when any doc's current version is unaccepted (first login OR version
//    bump). Recovery/claim routes are never gated: see
//    isLegalGateExemptPath in src/lib/legal-acceptance.ts.
//  * LegalAcceptanceModal — the blocking dialog itself: no dismiss/escape,
//    FR/EN toggle, one checkbox per document (no master checkbox), inline
//    scrollable risk disclosure whose checkbox unlocks only after the
//    reader reaches the end, and links opening the full pages in new tabs.
//
// Versions shown in the checkbox labels come from CURRENT_LEGAL_VERSIONS —
// the same server-resolved constant /api/legal/accept records; the client
// never submits a version. The DRAFT banner must remain until counsel signs
// off (LEGAL_DRAFT_NOTICE).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import {
  CURRENT_LEGAL_VERSIONS,
  LEGAL_DOC_IDS,
  LEGAL_DOC_LABELS,
  LEGAL_DOC_ROUTES,
  LEGAL_DRAFT_NOTICE,
  isLegalDocId,
  isLegalGateExemptPath,
  isLegalLocale,
  type LegalDocId,
  type LegalDocRender,
  type LegalLocale,
} from '../lib/legal-acceptance';
import { getLocale, setLocale } from '../lib/i18n';

// ---------------------------------------------------------------------------
// Localised UI strings (the legal documents themselves ship EN+FR only)
// ---------------------------------------------------------------------------

const UI_STRINGS: Record<
  LegalLocale,
  {
    title: string;
    intro: string;
    languageLabel: string;
    read: string;
    riskScrollHint: string;
    riskLoadError: string;
    checkboxLabel: (doc: LegalDocId, version: string) => string;
    summaries: Record<LegalDocId, string>;
    continueLabel: string;
    saving: string;
    submitError: string;
    retry: string;
    versionBumpNote: string;
  }
> = {
  en: {
    title: 'Before you start',
    intro:
      'Please review and accept the documents below. They explain how Njangi On-Chain works, how your data is handled, and the risks of using crypto assets.',
    languageLabel: 'Language',
    read: 'Read',
    riskScrollHint: 'Scroll to the end of the risk disclosure to enable its checkbox.',
    riskLoadError: 'Could not load the risk disclosure. Check your connection and retry.',
    checkboxLabel: (doc, version) =>
      `I have read and accept the ${LEGAL_DOC_LABELS.en[doc]} (v${version}).`,
    summaries: {
      terms:
        'The rules for using the service: non-custodial software, no guarantees on payouts, your responsibilities as a member.',
      privacy:
        'What data we process, how WhatsApp routing data is encrypted, and how to request deletion.',
      risk: 'The key risks of crypto-based savings circles, in plain language.',
    },
    continueLabel: 'Accept and continue',
    saving: 'Recording your acceptance…',
    submitError: 'We could not record your acceptance. Nothing was saved — please retry.',
    retry: 'Retry',
    versionBumpNote: 'An updated version of the document(s) below requires your acceptance.',
  },
  fr: {
    title: 'Avant de commencer',
    intro:
      "Veuillez lire et accepter les documents ci-dessous. Ils expliquent le fonctionnement de Njangi On-Chain, le traitement de vos données et les risques liés aux crypto-actifs.",
    languageLabel: 'Langue',
    read: 'Lire',
    riskScrollHint:
      "Faites défiler l'information sur les risques jusqu'à la fin pour activer sa case.",
    riskLoadError:
      "Impossible de charger l'information sur les risques. Vérifiez votre connexion et réessayez.",
    checkboxLabel: (doc, version) =>
      `J'ai lu et j'accepte ${
        doc === 'terms'
          ? 'les '
          : doc === 'privacy'
            ? 'la '
            : "l'"
      }${LEGAL_DOC_LABELS.fr[doc]} (v${version}).`,
    summaries: {
      terms:
        "Les règles d'utilisation du service : logiciel non dépositaire, aucune garantie de versement, vos responsabilités en tant que membre.",
      privacy:
        'Les données que nous traitons, le chiffrement des données de routage WhatsApp et la procédure de suppression.',
      risk: "Les principaux risques des tontines en crypto-actifs, expliqués simplement.",
    },
    continueLabel: 'Accepter et continuer',
    saving: 'Enregistrement de votre acceptation…',
    submitError:
      "Votre acceptation n'a pas pu être enregistrée. Rien n'a été sauvegardé — veuillez réessayer.",
    retry: 'Réessayer',
    versionBumpNote:
      'Une version mise à jour du ou des documents ci-dessous requiert votre acceptation.',
  },
};

// Scoped styles for the inline risk disclosure markdown (subset of the CSS
// used by src/pages/legal/[doc].tsx, namespaced to the modal).
const MODAL_DOC_CSS = `
.legal-modal-doc { color: #374151; font-size: 0.85rem; line-height: 1.6; }
.legal-modal-doc h1 { color: #111827; font-size: 1.05rem; font-weight: 700; margin: 1rem 0 0.5rem; }
.legal-modal-doc h2 { color: #111827; font-size: 0.95rem; font-weight: 700; margin: 1rem 0 0.4rem; }
.legal-modal-doc h3 { color: #111827; font-size: 0.9rem; font-weight: 600; margin: 0.85rem 0 0.35rem; }
.legal-modal-doc p { margin: 0.5rem 0; }
.legal-modal-doc ul, .legal-modal-doc ol { margin: 0.5rem 0 0.5rem 1.2rem; display: grid; gap: 0.25rem; }
.legal-modal-doc ul { list-style: disc; }
.legal-modal-doc ol { list-style: decimal; }
.legal-modal-doc blockquote { border-left: 3px solid #d97706; background: #fffbeb; color: #92400e; padding: 0.5rem 0.75rem; border-radius: 0 0.4rem 0.4rem 0; margin: 0.75rem 0; font-size: 0.8rem; }
.legal-modal-doc blockquote p { margin: 0.2rem 0; }
.legal-modal-doc code { background: #f1ece4; border: 1px solid #e6ddd1; border-radius: 0.3rem; padding: 0.05rem 0.3rem; font-size: 0.85em; color: #1f2937; }
.legal-modal-doc strong { color: #111827; font-weight: 700; }
.legal-modal-doc table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.8rem; display: block; overflow-x: auto; }
.legal-modal-doc th, .legal-modal-doc td { border: 1px solid #e6ddd1; padding: 0.4rem 0.5rem; text-align: left; vertical-align: top; }
.legal-modal-doc th { background: #f1ece4; color: #111827; font-weight: 600; }
`;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface LegalAcceptanceModalProps {
  /** Docs whose current version is unaccepted — the only docs shown. */
  missing: LegalDocId[];
  /** Called ONLY after /api/legal/accept returns 2xx (never optimistic). */
  onAccepted: () => void;
}

type RiskRenders = Record<LegalLocale, LegalDocRender>;

export function LegalAcceptanceModal({ missing, onAccepted }: LegalAcceptanceModalProps) {
  // Stable, canonically-ordered doc list for rendering + submission.
  const docs = useMemo(
    () => LEGAL_DOC_IDS.filter((doc) => missing.includes(doc)),
    [missing],
  );
  const needsRisk = docs.includes('risk');
  const isVersionBump = docs.length < LEGAL_DOC_IDS.length;

  const [lang, setLang] = useState<LegalLocale>('en');
  const [checked, setChecked] = useState<Record<LegalDocId, boolean>>({
    terms: false,
    privacy: false,
    risk: false,
  });
  const [riskRenders, setRiskRenders] = useState<RiskRenders | null>(null);
  const [riskLoadFailed, setRiskLoadFailed] = useState(false);
  const [riskReadToEnd, setRiskReadToEnd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [riskFetchNonce, setRiskFetchNonce] = useState(0);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const riskScrollRef = useRef<HTMLDivElement | null>(null);
  const riskSentinelRef = useRef<HTMLDivElement | null>(null);

  // Default language from the app-wide locale (only en/fr are published).
  useEffect(() => {
    const appLocale = getLocale();
    if (isLegalLocale(appLocale)) {
      setLang(appLocale);
    }
  }, []);

  const switchLang = (next: LegalLocale) => {
    setLang(next);
    // Persist the reader's choice app-wide (localStorage 'njangi.locale').
    setLocale(next);
  };

  // Load the risk disclosure for the inline scroll view.
  useEffect(() => {
    if (!needsRisk) return;
    let cancelled = false;
    setRiskLoadFailed(false);
    (async () => {
      try {
        const res = await fetch('/api/legal/doc?doc=risk');
        const data = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (data?.success && data.renders?.en?.html && data.renders?.fr?.html) {
          setRiskRenders(data.renders as RiskRenders);
        } else {
          setRiskLoadFailed(true);
        }
      } catch {
        if (!cancelled) setRiskLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsRisk, riskFetchNonce]);

  // Scroll-gate: the risk checkbox stays disabled until the end-of-document
  // sentinel becomes visible inside the scroll container. Once read, it
  // stays unlocked (switching language does not re-lock).
  useEffect(() => {
    if (!needsRisk || !riskRenders || riskReadToEnd) return;
    const sentinel = riskSentinelRef.current;
    const root = riskScrollRef.current;
    if (!sentinel || !root) return;
    if (typeof IntersectionObserver === 'undefined') {
      // Ancient browser fallback: never strand the user behind the gate.
      setRiskReadToEnd(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRiskReadToEnd(true);
        }
      },
      { root, threshold: 0.5 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [needsRisk, riskRenders, riskReadToEnd, lang]);

  // Blocking dialog behaviour: focus trap, no Escape dismiss, body scroll lock.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Blocking modal: acceptance is the only way forward.
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === firstEl || !dialog.contains(active)) {
          event.preventDefault();
          lastEl.focus();
        }
      } else if (active === lastEl || !dialog.contains(active)) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  const ui = UI_STRINGS[lang];
  const draft = LEGAL_DRAFT_NOTICE[lang];
  const allChecked = docs.every((doc) => checked[doc]);

  const handleContinue = useCallback(async () => {
    setSubmitting(true);
    setSubmitFailed(false);
    try {
      const res = await fetch('/api/legal/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Versions are intentionally absent: the server resolves them.
        body: JSON.stringify({ docs, locale: lang }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error('acceptance not recorded');
      }
      onAccepted();
    } catch {
      // Never proceed optimistically — surface a retry UI instead.
      setSubmitFailed(true);
    } finally {
      setSubmitting(false);
    }
  }, [docs, lang, onAccepted]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
    >
      <style dangerouslySetInnerHTML={{ __html: MODAL_DOC_CSS }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-acceptance-title"
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[#e6ddd1] bg-[#fbfaf7] shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[#e6ddd1] bg-[#f1ece4]/80 px-5 py-4">
          <h2 id="legal-acceptance-title" className="text-lg font-bold text-[#111827]">
            {ui.title}
          </h2>
          <div
            className="inline-flex shrink-0 overflow-hidden rounded-full border border-[#ddd5ca] bg-white text-xs font-semibold"
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
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* DRAFT banner — must remain until counsel signs off. */}
          <div
            role="status"
            className="mb-4 flex items-start gap-2 rounded-xl border border-amber-400 bg-amber-50 p-3 text-amber-900"
          >
            <span className="mt-0.5 shrink-0 rounded-md bg-amber-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              {draft.badge}
            </span>
            <p className="text-xs leading-relaxed">{draft.body}</p>
          </div>

          <p className="text-sm leading-relaxed text-[#374151]">{ui.intro}</p>
          {isVersionBump ? (
            <p className="mt-2 text-sm font-semibold text-[#111827]">{ui.versionBumpNote}</p>
          ) : null}

          <div className="mt-4 space-y-4">
            {docs.map((doc) => {
              const version = CURRENT_LEGAL_VERSIONS[doc];
              const isRisk = doc === 'risk';
              const riskCheckboxLocked = isRisk && !riskReadToEnd;
              return (
                <section
                  key={doc}
                  className="rounded-xl border border-[#e6ddd1] bg-white p-4"
                  aria-label={LEGAL_DOC_LABELS[lang][doc]}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-bold text-[#111827]">
                      {LEGAL_DOC_LABELS[lang][doc]}{' '}
                      <span className="font-normal text-[#6b7280]">v{version}</span>
                    </h3>
                    <a
                      href={`${LEGAL_DOC_ROUTES[doc]}?lang=${lang}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-semibold text-[#111827] underline underline-offset-4 hover:text-[#556070]"
                    >
                      {ui.read} ↗
                    </a>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-[#6b7280]">
                    {ui.summaries[doc]}
                  </p>

                  {isRisk ? (
                    <div className="mt-3">
                      {riskRenders ? (
                        <div
                          ref={riskScrollRef}
                          className="max-h-48 overflow-y-auto rounded-lg border border-[#e6ddd1] bg-[#fbfaf7] p-3"
                          tabIndex={0}
                          aria-label={LEGAL_DOC_LABELS[lang].risk}
                        >
                          <div
                            lang={lang}
                            className="legal-modal-doc"
                            dangerouslySetInnerHTML={{ __html: riskRenders[lang].html }}
                          />
                          {/* End-of-document sentinel for the scroll gate. */}
                          <div ref={riskSentinelRef} aria-hidden="true" className="h-px" />
                        </div>
                      ) : riskLoadFailed ? (
                        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                          {ui.riskLoadError}{' '}
                          <button
                            type="button"
                            onClick={() => setRiskFetchNonce((n) => n + 1)}
                            className="font-semibold underline underline-offset-2"
                          >
                            {ui.retry}
                          </button>
                        </div>
                      ) : (
                        <div className="h-24 animate-pulse rounded-lg border border-[#e6ddd1] bg-[#f1ece4]" />
                      )}
                      {riskCheckboxLocked && riskRenders ? (
                        <p className="mt-2 text-xs text-[#92400e]">{ui.riskScrollHint}</p>
                      ) : null}
                    </div>
                  ) : null}

                  <label
                    className={`mt-3 flex items-start gap-2 text-sm ${
                      riskCheckboxLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked[doc]}
                      disabled={riskCheckboxLocked || submitting}
                      onChange={(event) =>
                        setChecked((prev) => ({ ...prev, [doc]: event.target.checked }))
                      }
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-[#ddd5ca] accent-[#111827]"
                    />
                    <span className="text-[#374151]">{ui.checkboxLabel(doc, version)}</span>
                  </label>
                </section>
              );
            })}
          </div>
        </div>

        <footer className="border-t border-[#e6ddd1] bg-[#f1ece4]/60 px-5 py-4">
          {submitFailed ? (
            <p role="alert" className="mb-2 text-sm font-semibold text-red-700">
              {ui.submitError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={handleContinue}
            disabled={!allChecked || submitting}
            className="w-full rounded-xl bg-[#111827] px-4 py-3 text-sm font-bold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? ui.saving : submitFailed ? ui.retry : ui.continueLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gate — mounted once inside AuthProvider
// ---------------------------------------------------------------------------

export interface LegalAcceptanceGateProps {
  /** True once the user is authenticated (login or session restore). */
  active: boolean;
}

export function LegalAcceptanceGate({ active }: LegalAcceptanceGateProps) {
  const router = useRouter();
  const [missing, setMissing] = useState<LegalDocId[]>([]);

  useEffect(() => {
    if (!active) {
      setMissing([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/legal/status');
        if (!res.ok) {
          // 401 = no server-verified session (e.g. expired cookie after a
          // localStorage-only restore). Acceptance cannot be bound to an
          // identity, and no server-mediated action will succeed either —
          // don't block the UI; the gate re-runs on the next real login.
          return;
        }
        const data = await res.json();
        if (cancelled || !data?.success || data.allAccepted) return;
        const docs = Array.isArray(data.missing) ? data.missing.filter(isLegalDocId) : [];
        setMissing(docs);
      } catch {
        // Network hiccup: fail open for this read.
        //
        // This used to claim "server-side gates still hold". They did not —
        // `hasAcceptedAllLegalDocs` had zero callers, so acceptance was
        // recorded and never checked, and this modal was the only thing
        // standing between a user and a circle. A server gate now exists on
        // /api/join-requests/create, but it is one endpoint, not a general
        // backstop: client-signed on-chain actions still bypass it entirely.
        // Enforcing those needs the on-chain attestation gate
        // (njangi_compliance), not a server route.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  if (!active || missing.length === 0) {
    return null;
  }
  // NEVER gate recovery/claim (or the legal/auth pages themselves) — a
  // legal hold must not lock funds access. Deep links go straight through.
  if (isLegalGateExemptPath(router.pathname)) {
    return null;
  }

  return <LegalAcceptanceModal missing={missing} onAccepted={() => setMissing([])} />;
}

export default LegalAcceptanceModal;
