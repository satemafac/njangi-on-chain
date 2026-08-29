// /record/s/[token] — the read-only view behind a share link.
//
// Rendered for visitors with no account: a landlord, a cooperative, an
// organizer deciding whether to admit someone. It must therefore be
// self-explanatory and carry its own verification path, since the reader
// has no reason to trust us.
//
// noindex: a share link is a private disclosure the member chose to make
// to one recipient, not a public page.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { Loader2 } from 'lucide-react';
import { CircleRecordView } from '@/components/CircleRecordView';
import { Seo } from '@/components/Seo';
import { useTranslation } from '@/hooks/useTranslation';
import type { CircleRecord } from '@/lib/circle-record';

export default function SharedRecordPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const token = Array.isArray(router.query.token)
    ? router.query.token[0]
    : router.query.token;

  const [record, setRecord] = useState<CircleRecord | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>(
    'loading',
  );

  const load = useCallback(async (t: string) => {
    setState('loading');
    try {
      const res = await fetch(`/api/record/shared/${encodeURIComponent(t)}`);
      if (res.status === 404) {
        setState('missing');
        return;
      }
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setState('error');
        return;
      }
      setRecord(data.record as CircleRecord);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    if (!router.isReady || !token) return;
    void load(token);
  }, [router.isReady, token, load]);

  return (
    <>
      <Seo
        title="Savings circle record"
        description="A savings circle participation record, shared by the person it belongs to."
        noindex
        nofollow
      />
      <main className="min-h-screen bg-[#fbfaf7] px-4 py-10">
        {state === 'loading' ? (
          <div className="flex items-center justify-center py-24 text-[#556070]">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Loading…
          </div>
        ) : state === 'missing' ? (
          // Unknown, expired and revoked all land here — the API does not
          // distinguish them, so neither can this page.
          <div className="mx-auto max-w-md rounded-xl border border-[#e6ddd1] bg-white p-6 text-center">
            <h1 className="text-lg font-bold text-[#111827]">
              {t('record.shared.missingTitle')}
            </h1>
            <p className="mt-2 text-sm text-[#556070]">
              {t('record.shared.missingBody')}
            </p>
          </div>
        ) : state === 'error' || !record ? (
          <div className="mx-auto max-w-md rounded-xl border border-[#e6ddd1] bg-white p-6 text-center">
            <p className="text-sm text-[#374151]">
              {t('record.shared.loadFailed')}
            </p>
          </div>
        ) : (
          <CircleRecordView
            record={record}
            headerNote={t('record.sharedNote')}
          />
        )}
      </main>
    </>
  );
}
