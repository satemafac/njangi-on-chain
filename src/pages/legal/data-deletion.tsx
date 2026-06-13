// /legal/data-deletion — Real data-deletion request flow replacing the stale
// public/data-deletion.html mailto form. Submits to
// POST /api/legal/data-deletion-request, which records the request in the
// deletion_requests Postgres table.
//
// What deletion can and cannot do mirrors the Privacy Policy (Section 9):
// off-chain rows are deleted / cryptographically erased; on-chain data is
// permanent and unaffected.

import { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Manrope } from 'next/font/google';
import { getLocale, setLocale } from '../../lib/i18n';
import { isLegalLocale, type LegalLocale } from '../../lib/legal-acceptance';
import { LegalFooter } from '../../components/LegalFooter';

const bodyFont = Manrope({ subsets: ['latin'], display: 'swap' });

const SUI_ADDRESS_RE = /^0x[a-fA-F0-9]{1,64}$/;

const STRINGS: Record<LegalLocale, Record<string, string>> = {
  en: {
    home: 'Home',
    title: 'Data Deletion Request',
    intro:
      'Use this form to ask us to delete the personal data we hold about you off-chain (OAuth identifiers, email, wallet salt record, recovery-code hashes, WhatsApp routing data, join requests, preferences). We verify each request before acting on it and respond within the legally required time.',
    chainTitle: 'What deletion cannot do',
    chainBody:
      'Data on the public Sui blockchain — your wallet address, circle membership, and transaction history — is permanent and cannot be deleted by us or anyone else. Deletion severs the link between that address and the identity data we hold. Records we must keep by law (e.g. billing and legal-acceptance records) are retained.',
    walletWarning:
      'Warning: deleting your wallet salt record may make your wallet unrecoverable through this Service. Withdraw or transfer funds before requesting deletion.',
    emailLabel: 'Account email address',
    emailPlaceholder: 'The email of the Google / Facebook / Apple account you sign in with',
    addressLabel: 'Sui wallet address (optional)',
    addressPlaceholder: '0x…',
    detailsLabel: 'Additional details (optional)',
    detailsPlaceholder: 'Anything that helps us identify your data, or specific items to delete.',
    confirmLabel:
      'I understand that on-chain data cannot be deleted, that deleting my wallet salt record may make my wallet unrecoverable through this Service, and I want to proceed.',
    submit: 'Submit deletion request',
    submitting: 'Submitting…',
    successTitle: 'Request received',
    successBody:
      'We have recorded your deletion request. We will verify that it comes from the account holder and follow up at the email you provided.',
    alreadyPending:
      'A deletion request for this email is already pending. No new request was created — we will follow up on the existing one.',
    errorGeneric: 'Something went wrong. Please try again in a moment.',
    errorRateLimited: 'Too many requests. Please wait a moment and try again.',
    errorEmail: 'Please enter a valid email address.',
    errorAddress: 'That does not look like a valid Sui address (0x…).',
    errorConfirm: 'Please confirm you understand what deletion does before submitting.',
  },
  fr: {
    home: 'Accueil',
    title: 'Demande de suppression des données',
    intro:
      "Utilisez ce formulaire pour nous demander de supprimer les données personnelles que nous détenons hors chaîne (identifiants OAuth, courriel, sel cryptographique du portefeuille, empreintes des codes de récupération, données d'acheminement WhatsApp, demandes d'adhésion, préférences). Nous vérifions chaque demande avant d'agir et répondons dans le délai légal.",
    chainTitle: 'Ce que la suppression ne peut pas faire',
    chainBody:
      "Les données sur la blockchain publique Sui — votre adresse, votre appartenance aux cercles et votre historique de transactions — sont permanentes et ne peuvent être supprimées par personne. La suppression rompt le lien entre cette adresse et les données d'identité que nous détenons. Les registres que la loi nous impose de conserver (facturation, acceptations juridiques) sont conservés.",
    walletWarning:
      'Attention : la suppression du sel cryptographique de votre portefeuille peut rendre celui-ci irrécupérable via ce Service. Retirez ou transférez vos fonds avant de demander la suppression.',
    emailLabel: 'Adresse courriel du compte',
    emailPlaceholder: 'Le courriel du compte Google / Facebook / Apple utilisé pour vous connecter',
    addressLabel: 'Adresse de portefeuille Sui (facultatif)',
    addressPlaceholder: '0x…',
    detailsLabel: 'Précisions (facultatif)',
    detailsPlaceholder: 'Tout élément qui nous aide à identifier vos données, ou les éléments précis à supprimer.',
    confirmLabel:
      "Je comprends que les données sur la chaîne ne peuvent pas être supprimées, que la suppression du sel de mon portefeuille peut le rendre irrécupérable via ce Service, et je souhaite continuer.",
    submit: 'Envoyer la demande de suppression',
    submitting: 'Envoi…',
    successTitle: 'Demande reçue',
    successBody:
      "Votre demande de suppression a été enregistrée. Nous vérifierons qu'elle provient du titulaire du compte et vous répondrons à l'adresse indiquée.",
    alreadyPending:
      'Une demande de suppression pour ce courriel est déjà en cours. Aucune nouvelle demande créée — nous donnerons suite à la demande existante.',
    errorGeneric: "Une erreur s'est produite. Veuillez réessayer dans un instant.",
    errorRateLimited: 'Trop de requêtes. Veuillez patienter un instant puis réessayer.',
    errorEmail: 'Veuillez saisir une adresse courriel valide.',
    errorAddress: "Cette adresse ne ressemble pas à une adresse Sui valide (0x…).",
    errorConfirm: 'Veuillez confirmer que vous comprenez les effets de la suppression avant d’envoyer.',
  },
};

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; alreadyPending: boolean }
  | { kind: 'error'; message: string };

export default function DataDeletionPage() {
  const router = useRouter();
  const [lang, setLang] = useState<LegalLocale>('en');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [details, setDetails] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

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

  const t = STRINGS[lang];

  const switchLang = (next: LegalLocale) => {
    setLang(next);
    setLocale(next);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (state.kind === 'submitting') return;

    const trimmedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setState({ kind: 'error', message: t.errorEmail });
      return;
    }
    const trimmedAddress = address.trim();
    if (trimmedAddress && !SUI_ADDRESS_RE.test(trimmedAddress)) {
      setState({ kind: 'error', message: t.errorAddress });
      return;
    }
    if (!confirmed) {
      setState({ kind: 'error', message: t.errorConfirm });
      return;
    }

    setState({ kind: 'submitting' });
    try {
      const response = await fetch('/api/legal/data-deletion-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmedEmail,
          userAddress: trimmedAddress || undefined,
          details: details.trim() || undefined,
          locale: lang,
          website: honeypot || undefined,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        success?: boolean;
        alreadyPending?: boolean;
      } | null;

      if (response.status === 429) {
        setState({ kind: 'error', message: t.errorRateLimited });
        return;
      }
      if (!response.ok || !payload?.success) {
        setState({ kind: 'error', message: t.errorGeneric });
        return;
      }
      setState({ kind: 'success', alreadyPending: Boolean(payload.alreadyPending) });
    } catch {
      setState({ kind: 'error', message: t.errorGeneric });
    }
  };

  const inputClass =
    'w-full rounded-lg border border-[#ddd5ca] bg-white px-3 py-2.5 text-sm text-[#111827] placeholder:text-[#9ca3af] focus:border-[#111827] focus:outline-none';

  return (
    <>
      <Head>
        <title>Data Deletion Request | Njangi On-Chain</title>
        <meta
          name="description"
          content="Request deletion of the personal data Njangi On-Chain holds about you off-chain. On-chain data is permanent and cannot be deleted."
        />
        <link rel="canonical" href="https://njangionchain.com/legal/data-deletion" />
      </Head>

      <div className={`${bodyFont.className} min-h-screen bg-[#f6f2ea] text-[#374151]`}>
        <header className="border-b border-[#e6ddd1] bg-[#f1ece4]/80">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/" className="font-semibold text-[#111827] hover:underline">
                {t.home}
              </Link>
              <span className="rounded-full border border-[#ddd5ca] bg-white px-3 py-1 font-semibold text-[#111827]">
                {t.title}
              </span>
            </nav>
            <div
              className="inline-flex overflow-hidden rounded-full border border-[#ddd5ca] bg-white text-xs font-semibold"
              role="group"
              aria-label="Language"
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

        <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6" lang={lang}>
          <h1 className="text-2xl font-bold tracking-tight text-[#111827]">{t.title}</h1>
          <p className="mt-3 text-sm leading-relaxed">{t.intro}</p>

          <div className="mt-5 rounded-xl border border-[#ddd5ca] bg-white p-4">
            <h2 className="text-sm font-semibold text-[#111827]">{t.chainTitle}</h2>
            <p className="mt-2 text-sm leading-relaxed text-[#556070]">{t.chainBody}</p>
          </div>

          <div className="mt-4 rounded-xl border border-amber-400 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
            {t.walletWarning}
          </div>

          {state.kind === 'success' ? (
            <div
              role="status"
              className="mt-6 rounded-2xl border border-emerald-300 bg-emerald-50 p-6 text-emerald-900"
            >
              <h2 className="text-base font-semibold">{t.successTitle}</h2>
              <p className="mt-2 text-sm leading-relaxed">
                {state.alreadyPending ? t.alreadyPending : t.successBody}
              </p>
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="mt-6 rounded-2xl border border-[#e6ddd1] bg-[#fbfaf7] p-6 sm:p-8"
              noValidate
            >
              <div className="grid gap-5">
                <div>
                  <label htmlFor="deletion-email" className="mb-1.5 block text-sm font-semibold text-[#111827]">
                    {t.emailLabel}
                  </label>
                  <input
                    id="deletion-email"
                    type="email"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t.emailPlaceholder}
                    className={inputClass}
                  />
                </div>

                <div>
                  <label htmlFor="deletion-address" className="mb-1.5 block text-sm font-semibold text-[#111827]">
                    {t.addressLabel}
                  </label>
                  <input
                    id="deletion-address"
                    type="text"
                    maxLength={66}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder={t.addressPlaceholder}
                    className={inputClass}
                  />
                </div>

                <div>
                  <label htmlFor="deletion-details" className="mb-1.5 block text-sm font-semibold text-[#111827]">
                    {t.detailsLabel}
                  </label>
                  <textarea
                    id="deletion-details"
                    rows={4}
                    maxLength={1000}
                    value={details}
                    onChange={(e) => setDetails(e.target.value)}
                    placeholder={t.detailsPlaceholder}
                    className={`${inputClass} resize-y`}
                  />
                </div>

                {/* Honeypot — hidden from real users; bots fill it. */}
                <div className="hidden" aria-hidden="true">
                  <label htmlFor="deletion-website">Website</label>
                  <input
                    id="deletion-website"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={honeypot}
                    onChange={(e) => setHoneypot(e.target.value)}
                  />
                </div>

                <label className="flex items-start gap-3 text-sm leading-relaxed">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-1 h-4 w-4 shrink-0 rounded border-[#ddd5ca]"
                  />
                  <span>{t.confirmLabel}</span>
                </label>

                {state.kind === 'error' && (
                  <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
                    {state.message}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={state.kind === 'submitting'}
                  className="inline-flex items-center justify-center rounded-full bg-[#111827] px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {state.kind === 'submitting' ? t.submitting : t.submit}
                </button>
              </div>
            </form>
          )}

          <div className="mt-8 border-t border-[#ddd5c9] pt-4">
            <LegalFooter />
          </div>
        </main>
      </div>
    </>
  );
}
