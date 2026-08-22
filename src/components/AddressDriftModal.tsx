// AddressDriftModal — shown when signing in produced a different Sui
// address than this identity has used before.
//
// This is a rare, frightening, and entirely-our-fault situation: the user
// did nothing wrong, and their funds are at an address this sign-in can no
// longer reach. The copy therefore does three things and nothing else:
// says plainly what happened, shows the previous address so it is not lost,
// and points at support. It never blames the user, never says "salt", and
// never promises recovery we cannot deliver.
//
// Structure and conventions mirror LegalAcceptanceModal — same overlay,
// same dialog shell, same EN/FR toggle — so this reads as part of the app
// rather than an error page.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { isLegalGateExemptPath } from '../lib/legal-acceptance';

type Lang = 'en' | 'fr';

const COPY: Record<Lang, {
  title: string;
  intro: string;
  previousLabel: string;
  currentLabel: string;
  whatNow: string;
  reassure: string;
  canStill: string;
  cannotYet: string;
  support: string;
  languageLabel: string;
  dismiss: string;
}> = {
  en: {
    title: 'This sign-in opened a different account',
    intro:
      'Signing in just now gave you a different account than the one you used before. ' +
      'This is a problem on our side, not something you did.',
    previousLabel: 'Your previous account',
    currentLabel: 'The account you are in now',
    whatNow:
      'Anything you saved before — your circles and your money — is still at the previous ' +
      'account. It has not been lost or moved. But this sign-in cannot reach it, and we ' +
      'cannot move funds between accounts for you.',
    reassure:
      'We have been alerted automatically and are looking into it.',
    canStill:
      'You can still collect a payout that is owed to you, ask for a refund, and take part ' +
      'in your circle’s recovery vote.',
    cannotYet:
      'Joining a circle, creating one, and paying a contribution are paused until this is sorted out.',
    support: 'Please contact support and mention both accounts shown above.',
    languageLabel: 'Language',
    dismiss: 'I understand',
  },
  fr: {
    title: 'Cette connexion a ouvert un compte différent',
    intro:
      'La connexion que vous venez d’effectuer vous a donné un compte différent de celui que ' +
      'vous utilisiez auparavant. Le problème vient de nous, pas de vous.',
    previousLabel: 'Votre compte précédent',
    currentLabel: 'Le compte actuel',
    whatNow:
      'Tout ce que vous aviez — vos tontines et votre argent — se trouve toujours sur le compte ' +
      'précédent. Rien n’a été perdu ni déplacé. Mais cette connexion ne peut pas y accéder, et ' +
      'nous ne pouvons pas transférer des fonds d’un compte à l’autre à votre place.',
    reassure:
      'Nous avons été alertés automatiquement et nous examinons la situation.',
    canStill:
      'Vous pouvez toujours percevoir un versement qui vous est dû, demander un remboursement, ' +
      'et participer au vote de récupération de votre tontine.',
    cannotYet:
      'Rejoindre une tontine, en créer une, et payer une cotisation sont suspendus le temps de régler cela.',
    support: 'Veuillez contacter le support en mentionnant les deux comptes indiqués ci-dessus.',
    languageLabel: 'Langue',
    dismiss: 'J’ai compris',
  },
};

function shortenAddress(addr: string): string {
  if (!addr || addr.length <= 20) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}

export interface AddressDriftModalProps {
  currentAddress: string;
  previousAddresses: string[];
  onDismiss: () => void;
}

export function AddressDriftModal({
  currentAddress,
  previousAddresses,
  onDismiss,
}: AddressDriftModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [lang, setLang] = useState<Lang>('en');
  const t = COPY[lang];

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="address-drift-title"
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[#e6ddd1] bg-[#fbfaf7] shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[#e6ddd1] bg-[#f1ece4]/80 px-5 py-4">
          <h2 id="address-drift-title" className="text-lg font-bold text-[#111827]">
            {t.title}
          </h2>
          <div
            className="inline-flex shrink-0 overflow-hidden rounded-full border border-[#ddd5ca] bg-white text-xs font-semibold"
            role="group"
            aria-label={t.languageLabel}
          >
            {(['en', 'fr'] as const).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setLang(code)}
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
          <p className="text-sm leading-relaxed text-[#374151]">{t.intro}</p>

          <div className="mt-4 space-y-3">
            {previousAddresses.map((addr) => (
              <div
                key={addr}
                className="rounded-xl border border-[#e6ddd1] bg-white p-3"
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8578]">
                  {t.previousLabel}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-[#111827]" title={addr}>
                  {shortenAddress(addr)}
                </p>
              </div>
            ))}
            <div className="rounded-xl border border-[#e6ddd1] bg-white p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8578]">
                {t.currentLabel}
              </p>
              <p
                className="mt-1 break-all font-mono text-xs text-[#111827]"
                title={currentAddress}
              >
                {shortenAddress(currentAddress)}
              </p>
            </div>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-[#374151]">{t.whatNow}</p>
          <p className="mt-2 text-sm leading-relaxed text-[#374151]">{t.reassure}</p>

          <div className="mt-4 rounded-xl border border-emerald-300 bg-emerald-50 p-3">
            <p className="text-xs leading-relaxed text-emerald-900">{t.canStill}</p>
          </div>
          <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs leading-relaxed text-amber-900">{t.cannotYet}</p>
          </div>

          <p className="mt-4 text-sm font-semibold leading-relaxed text-[#111827]">
            {t.support}
          </p>
        </div>

        <footer className="border-t border-[#e6ddd1] bg-[#f1ece4]/60 px-5 py-4">
          <button
            type="button"
            onClick={onDismiss}
            className="w-full rounded-xl bg-[#111827] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1f2937]"
          >
            {t.dismiss}
          </button>
        </footer>
      </div>
    </div>
  );
}

export interface AddressDriftGateProps {
  /** True once the user is authenticated (login or session restore). */
  active: boolean;
}

/**
 * Polls the drift status once per authenticated session and raises the
 * modal if the identity has drifted.
 *
 * Mounted inside AuthProvider, NOT on /auth/callback: the callback page only
 * covers a fresh login, while the provider also covers localStorage session
 * restore — and a drifted user who closes the tab and returns must still see
 * this.
 */
export function AddressDriftGate({ active }: AddressDriftGateProps) {
  const router = useRouter();
  const [drift, setDrift] = useState<{
    currentAddress: string;
    previousAddresses: string[];
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!active) {
      setDrift(null);
      setDismissed(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/address-drift');
        if (!res.ok) {
          // 401 = no server-verified session (e.g. expired cookie after a
          // localStorage-only restore). Nothing to bind a status to; the
          // gate re-runs on the next real login.
          return;
        }
        const data = await res.json();
        if (cancelled || !data?.success || !data.drifted) return;
        setDrift({
          currentAddress: String(data.currentAddress ?? ''),
          previousAddresses: Array.isArray(data.previousAddresses)
            ? data.previousAddresses.map(String)
            : [],
        });
      } catch {
        // Network hiccup: fail open for this read. The server-side gates on
        // circle create/join still refuse the actual commitments, so a
        // missed interstitial degrades the warning, not the protection.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  if (!active || !drift || dismissed) {
    return null;
  }

  // Reuses the legal gate's exempt set deliberately rather than defining a
  // second one. The rule is identical — fund access (claim, refund,
  // recovery, withdraw) is never blocked, while the entry actions that
  // create a new commitment (join, contribute) are — and keeping one
  // implementation means the two gates cannot quietly diverge.
  if (isLegalGateExemptPath(router.pathname)) {
    return null;
  }

  return (
    <AddressDriftModal
      currentAddress={drift.currentAddress}
      previousAddresses={drift.previousAddresses}
      onDismiss={() => setDismissed(true)}
    />
  );
}

export default AddressDriftModal;
