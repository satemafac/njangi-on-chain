// /record — the member's own participation record: view, print, export,
// and create an expiring share link.
//
// Free for the member at every tier. Charging someone for their own
// history is indefensible and would contradict the pricing promise that
// the core mechanics are never behind a paywall.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Download, Link2, Printer, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '@/contexts/AuthContext';
import { useTranslation } from '@/hooks/useTranslation';
import { CircleRecordView } from '@/components/CircleRecordView';
import type { CircleRecord } from '@/lib/circle-record';

interface ShareLink {
  token: string;
  createdAtMs: number;
  expiresAtMs: number;
}

const TTL_CHOICES = [7, 30, 90];

export default function RecordPage() {
  const { t, locale } = useTranslation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [record, setRecord] = useState<CircleRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [creating, setCreating] = useState(false);
  const [ttlDays, setTtlDays] = useState(30);

  const loadRecord = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch('/api/record');
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setFailed(true);
        return;
      }
      setRecord(data.record as CircleRecord);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLinks = useCallback(async () => {
    try {
      const res = await fetch('/api/record/share');
      const data = await res.json();
      if (res.ok && data?.success) setLinks(data.links ?? []);
    } catch {
      // Non-fatal: the record itself still renders.
    }
  }, []);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    void loadRecord();
    void loadLinks();
  }, [authLoading, isAuthenticated, loadRecord, loadLinks]);

  const createLink = useCallback(async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/record/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlDays }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        toast.error(t('record.share.createFailed'));
        return;
      }
      await loadLinks();
      const url = `${window.location.origin}/record/s/${data.link.token}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success(t('record.share.createdCopied'));
      } catch {
        toast.success(t('record.share.created'));
      }
    } finally {
      setCreating(false);
    }
  }, [ttlDays, loadLinks, t]);

  const revokeLink = useCallback(
    async (token: string) => {
      const res = await fetch('/api/record/share', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        toast.success(t('record.share.revoked'));
        await loadLinks();
      } else {
        toast.error(t('record.share.revokeFailed'));
      }
    },
    [loadLinks, t],
  );

  const downloadJson = useCallback(() => {
    if (!record) return;
    const blob = new Blob([JSON.stringify(record, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `circle-record-${record.address.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [record]);

  if (!authLoading && !isAuthenticated) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-[#111827]">{t('record.page.signedOutTitle')}</h1>
        <p className="mt-3 text-sm text-[#556070]">
          {t('record.page.signedOutBody')}
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-xl bg-[#111827] px-5 py-2.5 text-sm font-semibold text-white"
        >
          {t('record.page.signedOutCta')}
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#fbfaf7] px-4 py-10">
      {loading || authLoading ? (
        <div className="flex items-center justify-center py-24 text-[#556070]">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          {t('record.page.loading')}
        </div>
      ) : failed || !record ? (
        <div className="mx-auto max-w-md rounded-xl border border-[#e6ddd1] bg-white p-6 text-center">
          <p className="text-sm text-[#374151]">
            {t('record.page.loadFailed')}
          </p>
          <button
            type="button"
            onClick={() => void loadRecord()}
            className="mt-4 rounded-xl bg-[#111827] px-4 py-2 text-sm font-semibold text-white"
          >
            {t('record.page.retry')}
          </button>
        </div>
      ) : (
        <>
          <CircleRecordView record={record} />

          <section className="mx-auto mt-10 w-full max-w-3xl rounded-xl border border-[#e6ddd1] bg-white p-5 print:hidden">
            <h2 className="text-sm font-bold uppercase tracking-wide text-[#111827]">
              {t('record.share.heading')}
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-[#556070]">
              {t('record.share.blurb')}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <label className="text-xs text-[#556070]" htmlFor="ttl">
                {t('record.share.lasts')}
              </label>
              <select
                id="ttl"
                value={ttlDays}
                onChange={(e) => setTtlDays(Number(e.target.value))}
                className="rounded-lg border border-[#ddd5ca] bg-white px-2 py-1.5 text-sm"
              >
                {TTL_CHOICES.map((d) => (
                  <option key={d} value={d}>
                    {t('record.share.days', { n: d })}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void createLink()}
                disabled={creating}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#111827] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {creating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="h-4 w-4" />
                )}
                {t('record.share.create')}
              </button>
              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#ddd5ca] px-4 py-2 text-sm font-semibold text-[#111827]"
              >
                <Printer className="h-4 w-4" />
                {t('record.share.print')}
              </button>
              <button
                type="button"
                onClick={downloadJson}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#ddd5ca] px-4 py-2 text-sm font-semibold text-[#111827]"
              >
                <Download className="h-4 w-4" />
                {t('record.share.download')}
              </button>
            </div>

            {links.length > 0 ? (
              <ul className="mt-4 space-y-2">
                {links.map((l) => (
                  <li
                    key={l.token}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#eee9e1] bg-[#fbfaf7] px-3 py-2"
                  >
                    <span className="break-all font-mono text-[11px] text-[#556070]">
                      /record/s/{l.token.slice(0, 12)}…
                    </span>
                    <span className="text-[11px] text-[#8a8578]">
                      {t('record.share.until', { date: new Date(l.expiresAtMs).toLocaleDateString(locale) })}
                    </span>
                    <button
                      type="button"
                      onClick={() => void revokeLink(l.token)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#8E2F3C]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('record.share.revoke')}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}
