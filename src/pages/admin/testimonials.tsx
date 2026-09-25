// /admin/testimonials — the operator's review queue for member stories.
//
// Same operating model as /admin/compliance: the page requires a signed-in
// session, and every request carries the operator secret pasted into the
// page (COMPLIANCE_ISSUANCE_SECRET). Nothing here is reachable without it.
//
// A story is only ever used in marketing after a human clicks "Approve"
// here. "Used" is bookkeeping. "Withdraw" honours a member's request and
// removes the story from every list.

import React, { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { toast } from 'react-hot-toast';
import { useAuth } from '@/contexts/AuthContext';
import type { Testimonial, TestimonialStatus } from '@/lib/testimonials';

const STATUSES: TestimonialStatus[] = ['pending', 'approved', 'used', 'withdrawn'];

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export default function AdminTestimonialsPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [secret, setSecret] = useState('');
  const [status, setStatus] = useState<TestimonialStatus>('pending');
  const [rows, setRows] = useState<Testimonial[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) router.replace('/');
  }, [authLoading, isAuthenticated, router]);

  const load = useCallback(async () => {
    if (secret.length < 16) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch(`/api/admin/testimonials?status=${status}`, {
        headers: { 'x-internal-auth': secret },
      });
      if (!resp.ok) {
        if (resp.status !== 401) toast.error(`Queue fetch failed (${resp.status})`);
        setRows([]);
        return;
      }
      const body = (await resp.json()) as { testimonials: Testimonial[] };
      setRows(body.testimonials ?? []);
    } catch (err) {
      console.warn('[admin/testimonials] load failed', err);
    } finally {
      setLoading(false);
    }
  }, [secret, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const transition = useCallback(
    async (id: number, next: TestimonialStatus) => {
      const resp = await fetch('/api/admin/testimonials', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-internal-auth': secret },
        body: JSON.stringify({ id, status: next }),
      });
      if (!resp.ok) {
        toast.error(`Update failed (${resp.status})`);
        return;
      }
      toast.success(`Marked ${next}.`);
      void load();
    },
    [secret, load],
  );

  return (
    <>
      <Head>
        <title>Member stories · Njangi On-Chain</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <main className="mx-auto max-w-3xl px-4 py-10 text-[#171923]">
        <h1 className="text-2xl font-semibold tracking-[-0.03em]">Member stories</h1>
        <p className="mt-2 text-sm leading-6 text-[#5d6674]">
          Stories members chose to share at their payout moment, with explicit consent.
          Nothing leaves this queue for marketing until you approve it here. A member can
          withdraw at any time; withdrawn stories are never used.
        </p>

        <label className="mt-6 block text-xs font-medium uppercase tracking-[0.14em] text-[#8b8578]">
          Operator secret
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="COMPLIANCE_ISSUANCE_SECRET"
            className="mt-1 w-full rounded-[14px] border border-[#e9e1d6] bg-white p-2.5 text-sm normal-case tracking-normal"
          />
        </label>

        <div className="mt-5 flex flex-wrap gap-2">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded-full border px-4 py-1.5 text-sm font-medium ${
                s === status
                  ? 'border-[#1d2533] bg-[#1d2533] text-white'
                  : 'border-[#d5ccbf] bg-white text-[#334155] hover:bg-[#f6f3ee]'
              }`}
            >
              {s}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load()}
            className="ml-auto rounded-full border border-[#d5ccbf] bg-white px-4 py-1.5 text-sm font-medium text-[#334155] hover:bg-[#f6f3ee]"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        <ul className="mt-5 space-y-3">
          {rows.length === 0 ? (
            <li className="rounded-[18px] border border-dashed border-[#e9e1d6] p-6 text-center text-sm text-[#8b8578]">
              {secret.length < 16 ? 'Paste the operator secret to load the queue.' : `No ${status} stories.`}
            </li>
          ) : null}
          {rows.map((r) => (
            <li key={r.id} className="rounded-[18px] border border-[#e9e1d6] bg-white p-4">
              <blockquote className="text-sm leading-6 text-[#171923]">“{r.quote}”</blockquote>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#8b8578]">
                <span>member {shortAddr(r.userAddress)}</span>
                <span>circle {shortAddr(r.circleId)}</span>
                <span>{new Date(r.createdAtMs).toLocaleString()}</span>
                <span>consent {r.consentMarketing ? 'yes' : 'no'}</span>
              </div>
              {r.status !== 'withdrawn' ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.status !== 'approved' ? (
                    <button type="button" onClick={() => void transition(r.id, 'approved')} className="rounded-full bg-[#1d2533] px-4 py-1.5 text-xs font-semibold text-white">
                      Approve
                    </button>
                  ) : null}
                  {r.status === 'approved' ? (
                    <button type="button" onClick={() => void transition(r.id, 'used')} className="rounded-full border border-[#d5ccbf] bg-white px-4 py-1.5 text-xs font-semibold text-[#334155]">
                      Mark used
                    </button>
                  ) : null}
                  <button type="button" onClick={() => void transition(r.id, 'withdrawn')} className="rounded-full border border-[#e5c9c9] bg-white px-4 py-1.5 text-xs font-semibold text-[#8a2f2f]">
                    Withdraw
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
