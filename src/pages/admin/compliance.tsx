import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { toast } from 'react-hot-toast';
import { useAuth } from '@/contexts/AuthContext';
import { useZkLoginSigner } from '@/hooks/useZkLoginSigner';
import { getCurrentNetwork } from '@/services/network-config';
import type { NetworkType } from '@/services/whatsapp-registry-service';
import { findOwnedAttestorCaps, type AttestorCapRef } from '@/lib/attestor-cap-discovery';

interface QueueEntry {
  id: string;
  subject: string;
  providerCaseId: string;
  providerCasePreview: string;
  policy: {
    name: string;
    version: string;
    issuer: string;
    provider: 'coinbase' | 'moonpay' | 'transak' | 'internal';
    criteria: string;
  };
  ttlMs: number;
  network: 'testnet' | 'mainnet';
  queuedAt: number;
  status: 'pending' | 'issued' | 'dismissed';
}

/**
 * /admin/compliance — issuer-only page for minting ComplianceAttestation
 * objects. Only the address holding the AttestorCap can successfully run
 * the Move transaction; we still require the internal compliance secret
 * before the preflight endpoint will hash anything, so unauthorised
 * browsers can't even learn the policy/ref hash values.
 *
 * Flow:
 *   1. Operator enters the AttestorCap object id (shown once at deploy).
 *   2. Operator enters subject address + provider case id + policy.
 *   3. We POST to /api/compliance/prepare-issuance with the shared secret
 *      to get back the policy and ref hashes.
 *   4. The client-side zkLogin signer constructs a single PTB that calls
 *      `njangi_compliance::issue(cap, subject, policy_hash, ref_hash,
 *      ttl_ms, clock)` and submits it directly from the browser.
 */

interface PreparedIssuance {
  policyHashHex: string;
  externalRefHashHex: string;
  ttlMs: number;
}

const DEFAULT_TTL_DAYS = 90;

export default function AdminCompliancePage() {
  const router = useRouter();
  const { isAuthenticated, userAddress } = useAuth();
  const { isReady, signAndExecute } = useZkLoginSigner();

  const [network, setNetwork] = useState<NetworkType>('testnet');
  const [attestorCapId, setAttestorCapId] = useState('');
  const [ownedCaps, setOwnedCaps] = useState<AttestorCapRef[]>([]);
  const [capsLoading, setCapsLoading] = useState(false);
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [activeQueueEntryId, setActiveQueueEntryId] = useState<string | null>(null);
  // Phase 12 publish-readiness: surface stale-attestation list +
  // notification audit log so ops have everything in one console.
  const [staleCircleIdsInput, setStaleCircleIdsInput] = useState('');
  const [staleEntries, setStaleEntries] = useState<
    Array<{ circleId: string; cycleNo: number; memberAddress: string; reason: string }>
  >([]);
  const [staleLoading, setStaleLoading] = useState(false);
  const [staleNudging, setStaleNudging] = useState(false);
  const [notificationAddress, setNotificationAddress] = useState('');
  const [notificationRows, setNotificationRows] = useState<
    Array<{ kind: string; dedupeKey: string; sentAt: string; success: boolean; error: string | null }>
  >([]);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [subject, setSubject] = useState('');
  const [providerCaseId, setProviderCaseId] = useState('');
  const [policyName, setPolicyName] = useState('Partner KYC');
  const [policyVersion, setPolicyVersion] = useState('1.0.0');
  const [provider, setProvider] = useState<'coinbase' | 'moonpay' | 'transak' | 'internal'>(
    'internal',
  );
  const [criteria, setCriteria] = useState(
    'Identity verified, sanctions screened, jurisdiction allow-listed.',
  );
  const [ttlDays, setTtlDays] = useState<number>(DEFAULT_TTL_DAYS);
  const [internalSecret, setInternalSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastDigest, setLastDigest] = useState<string | null>(null);

  useEffect(() => {
    setNetwork(getCurrentNetwork() as NetworkType);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/');
    }
  }, [isAuthenticated, router]);

  // P9A: auto-discover the AttestorCap(s) the signed-in operator owns so
  // single-cap ops get a deterministic prefill. Multi-cap environments
  // still see the dropdown + manual override.
  useEffect(() => {
    if (!userAddress) {
      setOwnedCaps([]);
      return;
    }
    let cancelled = false;
    setCapsLoading(true);
    findOwnedAttestorCaps(userAddress, network)
      .then((caps) => {
        if (cancelled) return;
        setOwnedCaps(caps);
        if (caps.length === 1 && !attestorCapId) {
          setAttestorCapId(caps[0].objectId);
        }
      })
      .catch((err) => {
        console.warn('[admin/compliance] AttestorCap discovery failed', err);
      })
      .finally(() => {
        if (!cancelled) setCapsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  // The effect intentionally skips `attestorCapId` from its deps — we
  // only want to auto-prefill once per network/user change, not on every
  // keystroke in the override input.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAddress, network]);

  const refreshQueue = useCallback(
    async (secret?: string) => {
      const authToken = secret ?? internalSecret;
      if (!authToken) {
        setQueueEntries([]);
        return;
      }
      setQueueLoading(true);
      try {
        const resp = await fetch('/api/compliance/queue', {
          headers: { 'x-internal-auth': authToken },
        });
        if (!resp.ok) {
          if (resp.status !== 401) {
            toast.error(`Queue fetch failed (${resp.status})`);
          }
          setQueueEntries([]);
          return;
        }
        const body = (await resp.json()) as { entries: QueueEntry[] };
        setQueueEntries(body.entries ?? []);
      } catch (err) {
        console.warn('[admin/compliance] queue refresh failed', err);
      } finally {
        setQueueLoading(false);
      }
    },
    [internalSecret],
  );

  const prefillFromQueueEntry = useCallback(
    (entry: QueueEntry) => {
      setActiveQueueEntryId(entry.id);
      setSubject(entry.subject);
      setProviderCaseId(entry.providerCaseId);
      setPolicyName(entry.policy.name);
      setPolicyVersion(entry.policy.version);
      setProvider(entry.policy.provider);
      setCriteria(entry.policy.criteria);
      setNetwork(entry.network);
      setTtlDays(Math.max(1, Math.round(entry.ttlMs / (24 * 60 * 60 * 1000))));
    },
    [],
  );

  const dismissQueueEntry = useCallback(
    async (entryId: string) => {
      if (!internalSecret) return;
      try {
        const resp = await fetch('/api/compliance/queue', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-auth': internalSecret,
          },
          body: JSON.stringify({ id: entryId, action: 'dismissed' }),
        });
        if (!resp.ok) {
          toast.error('Failed to dismiss entry');
          return;
        }
        await refreshQueue();
        if (activeQueueEntryId === entryId) setActiveQueueEntryId(null);
      } catch (err) {
        toast.error(
          `Failed to dismiss entry: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [internalSecret, refreshQueue, activeQueueEntryId],
  );

  const fetchStale = useCallback(
    async (nudge = false) => {
      if (!internalSecret) {
        toast.error('Enter the compliance secret first.');
        return;
      }
      const ids = staleCircleIdsInput
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.startsWith('0x'));
      if (ids.length === 0) {
        toast.error('Add at least one circle id (comma-separated).');
        return;
      }
      const setter = nudge ? setStaleNudging : setStaleLoading;
      setter(true);
      try {
        const resp = await fetch('/api/admin/compliance/stale', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-auth': internalSecret,
          },
          body: JSON.stringify({ network, circleIds: ids, nudge }),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          toast.error(`Stale fetch failed (${resp.status}): ${text || 'no body'}`);
          return;
        }
        const body = (await resp.json()) as {
          stale: typeof staleEntries;
          nudged?: number;
        };
        setStaleEntries(body.stale ?? []);
        if (nudge) {
          toast.success(`Nudged ${body.nudged ?? 0} member(s).`);
        }
      } finally {
        setter(false);
      }
    },
    [internalSecret, network, staleCircleIdsInput],
  );

  const fetchNotifications = useCallback(async () => {
    if (!internalSecret) {
      toast.error('Enter the compliance secret first.');
      return;
    }
    if (!notificationAddress.startsWith('0x')) {
      toast.error('Address must start with 0x.');
      return;
    }
    setNotificationLoading(true);
    try {
      const resp = await fetch(
        `/api/admin/notifications/recent?address=${encodeURIComponent(notificationAddress)}&limit=50`,
        { headers: { 'x-internal-auth': internalSecret } },
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        toast.error(`Notifications fetch failed (${resp.status}): ${text || 'no body'}`);
        return;
      }
      const body = (await resp.json()) as { rows: typeof notificationRows };
      setNotificationRows(body.rows ?? []);
    } finally {
      setNotificationLoading(false);
    }
  }, [internalSecret, notificationAddress]);

  const packageId = useMemo(() => {
    const envKey =
      network === 'mainnet'
        ? 'NEXT_PUBLIC_MAINNET_PACKAGE_ID'
        : 'NEXT_PUBLIC_TESTNET_PACKAGE_ID';
    return process.env[envKey];
  }, [network]);

  const prepareAndSign = useCallback(async () => {
    if (!isReady) {
      toast.error('Sign in again — the client-side signer is not ready.');
      return;
    }
    if (!attestorCapId || !subject || !providerCaseId) {
      toast.error('AttestorCap, subject, and provider case id are required.');
      return;
    }
    if (!packageId) {
      toast.error('Package id is not configured for this network.');
      return;
    }
    if (!internalSecret) {
      toast.error('Internal compliance secret is required to preflight the hashes.');
      return;
    }

    setBusy(true);
    try {
      const prepResp = await fetch('/api/compliance/prepare-issuance', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-auth': internalSecret,
        },
        body: JSON.stringify({
          subject,
          providerCaseId,
          network,
          policy: {
            name: policyName,
            version: policyVersion,
            issuer: userAddress ?? 'unknown',
            provider,
            criteria,
          },
          ttlMs: ttlDays * 24 * 60 * 60 * 1000,
        }),
      });
      if (!prepResp.ok) {
        const body = await prepResp.text().catch(() => '');
        throw new Error(`Preflight failed (${prepResp.status}): ${body}`);
      }
      const prepared = (await prepResp.json()) as PreparedIssuance;

      const policyBytes = hexToBytes(prepared.policyHashHex);
      const refBytes = hexToBytes(prepared.externalRefHashHex);

      const result = await signAndExecute({
        gasBudget: 80_000_000,
        build: (txb) => {
          txb.moveCall({
            target: `${packageId}::njangi_compliance::issue`,
            arguments: [
              txb.object(attestorCapId),
              txb.pure.address(subject),
              txb.pure.vector('u8', Array.from(policyBytes)),
              txb.pure.vector('u8', Array.from(refBytes)),
              txb.pure.u64(prepared.ttlMs),
              txb.object('0x6'),
            ],
          });
        },
      });

      setLastDigest(result.digest);
      toast.success('Attestation issued. Member can now pay or collect in gated circles.');

      if (activeQueueEntryId) {
        try {
          await fetch('/api/compliance/queue', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-auth': internalSecret,
            },
            body: JSON.stringify({
              id: activeQueueEntryId,
              action: 'issued',
              digest: result.digest,
            }),
          });
          setActiveQueueEntryId(null);
          await refreshQueue();
        } catch (err) {
          console.warn('[admin/compliance] failed to mark queue entry issued', err);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Issuance failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }, [
    isReady,
    signAndExecute,
    attestorCapId,
    subject,
    providerCaseId,
    network,
    packageId,
    internalSecret,
    policyName,
    policyVersion,
    provider,
    criteria,
    ttlDays,
    userAddress,
    activeQueueEntryId,
    refreshQueue,
  ]);

  // Pull the pending-attestation queue whenever the operator enters or
  // updates the shared secret. We wait for the full secret to be pasted
  // (16+ chars) to avoid hammering the endpoint on every keystroke.
  useEffect(() => {
    if (internalSecret.length < 16) {
      setQueueEntries([]);
      return;
    }
    void refreshQueue(internalSecret);
  }, [internalSecret, refreshQueue]);

  return (
    <>
      <Head>
        <title>Compliance · Attestor console</title>
      </Head>
      <main className="mx-auto max-w-2xl px-4 py-10">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-700">
            Compliance
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900">Attestor console</h1>
          <p className="mt-2 text-sm text-slate-600">
            Mint a compliance attestation for a member after a ramp partner
            returns a successful KYC / sanctions decision. The member will
            then be able to pay into gated circles and collect payouts
            without any further friction.
          </p>
        </header>

        {internalSecret.length >= 16 ? (
          <section className="mb-6 rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5 shadow-sm">
            <header className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-800">
                  Pending KYC approvals
                </p>
                <p className="mt-1 text-sm text-emerald-900">
                  Ramp partners queue members here after a successful KYC decision. Tap an entry to
                  pre-fill the form below.
                </p>
              </div>
              <button
                type="button"
                onClick={() => refreshQueue()}
                className="text-xs font-medium text-emerald-800 hover:text-emerald-900"
                disabled={queueLoading}
              >
                {queueLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </header>
            {queueEntries.length === 0 ? (
              <p className="text-sm text-emerald-900/80">
                No pending approvals right now. New ramp-partner webhooks will appear here
                automatically.
              </p>
            ) : (
              <ul className="space-y-2">
                {queueEntries.map((entry) => (
                  <li
                    key={entry.id}
                    className={`flex items-center justify-between gap-3 rounded-xl border bg-white px-3 py-2 ${
                      activeQueueEntryId === entry.id
                        ? 'border-emerald-400 ring-2 ring-emerald-200'
                        : 'border-emerald-100'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">
                        {entry.subject}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {entry.policy.provider} · {entry.providerCasePreview} ·{' '}
                        {Math.round(entry.ttlMs / (24 * 60 * 60 * 1000))}d
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => prefillFromQueueEntry(entry)}
                        className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        Use
                      </button>
                      <button
                        type="button"
                        onClick={() => dismissQueueEntry(entry.id)}
                        className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                      >
                        Dismiss
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <Field label="Network">
            <select
              value={network}
              onChange={(e) => setNetwork(e.target.value as NetworkType)}
              className={inputClass}
            >
              <option value="testnet">testnet</option>
              <option value="mainnet">mainnet</option>
            </select>
          </Field>

          <Field
            label="AttestorCap object id"
            hint={
              capsLoading
                ? 'Checking which AttestorCap objects your wallet owns…'
                : ownedCaps.length > 0
                  ? `Auto-detected ${ownedCaps.length} AttestorCap${ownedCaps.length === 1 ? '' : 's'} in your wallet. You can still paste a different id below.`
                  : 'Issued once at deploy; store in ops vault.'
            }
          >
            {ownedCaps.length > 1 ? (
              <select
                value={attestorCapId}
                onChange={(e) => setAttestorCapId(e.target.value.trim())}
                className={inputClass}
              >
                <option value="">Select an AttestorCap…</option>
                {ownedCaps.map((cap) => (
                  <option key={cap.objectId} value={cap.objectId}>
                    {cap.objectId}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={attestorCapId}
                onChange={(e) => setAttestorCapId(e.target.value.trim())}
                placeholder="0x…"
                className={inputClass}
              />
            )}
          </Field>

          <Field label="Subject address" hint="The member who has passed KYC.">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value.trim())}
              placeholder="0x…"
              className={inputClass}
            />
          </Field>

          <Field label="Provider case id" hint="Ramp partner's internal reference (kept private).">
            <input
              value={providerCaseId}
              onChange={(e) => setProviderCaseId(e.target.value)}
              placeholder="moonpay:abcd1234"
              className={inputClass}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Policy name">
              <input
                value={policyName}
                onChange={(e) => setPolicyName(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Policy version">
              <input
                value={policyVersion}
                onChange={(e) => setPolicyVersion(e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Ramp partner">
            <select
              value={provider}
              onChange={(e) =>
                setProvider(e.target.value as 'coinbase' | 'moonpay' | 'transak' | 'internal')
              }
              className={inputClass}
            >
              <option value="internal">Internal (manual review)</option>
              <option value="coinbase">Coinbase</option>
              <option value="moonpay">MoonPay</option>
              <option value="transak">Transak</option>
            </select>
          </Field>

          <Field label="Criteria summary" hint="Not stored on chain; retained for audit logs.">
            <textarea
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              className={`${inputClass} min-h-[96px]`}
            />
          </Field>

          <Field label="Validity (days)">
            <input
              type="number"
              min={1}
              max={365}
              value={ttlDays}
              onChange={(e) => setTtlDays(Number(e.target.value))}
              className={inputClass}
            />
          </Field>

          <Field
            label="Internal compliance secret"
            hint="Matches COMPLIANCE_ISSUANCE_SECRET (falls back to INTERNAL_NOTIFY_SECRET)."
          >
            <input
              value={internalSecret}
              onChange={(e) => setInternalSecret(e.target.value)}
              type="password"
              className={inputClass}
            />
          </Field>

          <button
            type="button"
            onClick={prepareAndSign}
            disabled={busy || !isReady}
            className="mt-2 inline-flex items-center justify-center rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? 'Issuing…' : 'Issue attestation'}
          </button>

          {lastDigest ? (
            <p className="text-[11px] text-slate-500">
              Last transaction: <code className="break-all">{lastDigest}</code>
            </p>
          ) : null}
        </section>

        <section className="mt-6 space-y-4 rounded-2xl border border-amber-200 bg-amber-50/40 p-5 shadow-sm">
          <header>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">
              Members blocked by KYC
            </p>
            <p className="mt-1 text-sm text-amber-900">
              Lists members in compliance-gated circles that don&rsquo;t hold a current
              attestation. Tap <strong>Nudge all</strong> to send the localized WhatsApp
              reminder via the central dispatcher.
            </p>
          </header>
          <Field
            label="Circle ids"
            hint="Comma-separated 0x… ids. Use the manage page or `sui client object` to grab them."
          >
            <textarea
              value={staleCircleIdsInput}
              onChange={(e) => setStaleCircleIdsInput(e.target.value)}
              placeholder="0xcircle1, 0xcircle2"
              className={`${inputClass} min-h-[72px]`}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => fetchStale(false)}
              disabled={staleLoading || !internalSecret}
              className="inline-flex items-center justify-center rounded-full border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            >
              {staleLoading ? 'Loading…' : 'Refresh stale list'}
            </button>
            <button
              type="button"
              onClick={() => fetchStale(true)}
              disabled={staleNudging || !internalSecret || staleEntries.length === 0}
              className="inline-flex items-center justify-center rounded-full bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {staleNudging ? 'Nudging…' : `Nudge all (${staleEntries.length})`}
            </button>
          </div>
          {staleEntries.length === 0 ? (
            <p className="text-sm text-amber-900/70">
              {staleLoading ? 'Looking up members…' : 'No stale members for the supplied circles.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {staleEntries.map((entry) => (
                <li
                  key={`${entry.circleId}:${entry.memberAddress}:${entry.cycleNo}`}
                  className="rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm"
                >
                  <p className="font-medium text-slate-900 break-all">{entry.memberAddress}</p>
                  <p className="text-[11px] text-slate-500">
                    {entry.circleId.slice(0, 10)}… · round {entry.cycleNo} · {entry.reason}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <header>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-600">
              Recent notifications
            </p>
            <p className="mt-1 text-sm text-slate-700">
              Replays the last sends from <code>whatsapp_notifications</code> so you can
              confirm a nudge actually went out before paging support.
            </p>
          </header>
          <Field label="Member address (0x…)">
            <input
              value={notificationAddress}
              onChange={(e) => setNotificationAddress(e.target.value.trim())}
              placeholder="0x…"
              className={inputClass}
            />
          </Field>
          <button
            type="button"
            onClick={fetchNotifications}
            disabled={notificationLoading || !internalSecret}
            className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {notificationLoading ? 'Loading…' : 'Fetch notifications'}
          </button>
          {notificationRows.length === 0 ? (
            <p className="text-sm text-slate-500">
              {notificationLoading
                ? 'Loading…'
                : 'No notifications yet for this address (or none in the audit log).'}
            </p>
          ) : (
            <table className="w-full table-fixed border-separate border-spacing-y-1 text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="w-1/4">Sent</th>
                  <th className="w-1/4">Kind</th>
                  <th className="w-1/4">Dedupe key</th>
                  <th className="w-1/4">Status</th>
                </tr>
              </thead>
              <tbody>
                {notificationRows.map((row, idx) => (
                  <tr key={`${row.kind}-${row.dedupeKey}-${idx}`} className="bg-slate-50/60">
                    <td className="rounded-l-md px-2 py-1.5 text-slate-700">
                      {new Date(row.sentAt).toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5 text-slate-700">{row.kind}</td>
                    <td className="px-2 py-1.5 text-slate-500 break-all">{row.dedupeKey}</td>
                    <td className="rounded-r-md px-2 py-1.5">
                      {row.success ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                          sent
                        </span>
                      ) : (
                        <span
                          title={row.error ?? undefined}
                          className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700"
                        >
                          {row.error ? row.error.slice(0, 24) : 'failed'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="block font-medium text-slate-800">{label}</span>
      {hint ? <span className="mt-0.5 block text-xs text-slate-500">{hint}</span> : null}
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputClass =
  'block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return new Uint8Array(
    clean
      .match(/.{1,2}/g)
      ?.map((byte) => parseInt(byte, 16)) ?? [],
  );
}
