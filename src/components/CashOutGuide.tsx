// CashOutGuide.tsx — guided "send to your exchange" (off-ramp) flow.
//
// The reverse of ReceiveFundsModal: a member sends USDC (or SUI) FROM their
// in-app wallet TO a centralized exchange deposit address, then sells to fiat
// (P2P XAF via MTN MoMo / Orange Money in Cameroon, or bank in the diaspora).
//
// This is a guided WRAPPER around a send — it validates and confirms, then
// calls the injected `onSend`. It never holds funds or keys itself. The safety
// affordances (checksum echo, forced confirmations, test-small default, "Sui
// needs no memo") exist because wrong-address / wrong-network sends are the #1
// way users lose money moving off-chain.
//
// i18n TODO: strings collected in STRINGS for a later extraction pass.

import React, { useMemo, useState } from 'react';

const STRINGS = {
  title: 'Cash out',
  subtitle: 'Send to your exchange, then sell to your local currency',
  asset: 'Asset to send',
  destination: 'Exchange deposit address',
  destinationHint: 'Paste the USDC deposit address from your exchange (Sui network).',
  amount: 'Amount',
  max: 'Max',
  testFirst: 'Send a small test first',
  checklistTitle: 'Before you send',
  confirmChecksum:
    'I checked the first 4 and last 4 characters match my exchange deposit address',
  confirmFromExchange: 'This address is from my exchange’s USDC deposit page',
  confirmNetwork: 'I selected the Sui network on the exchange',
  noMemo: 'Sui does not use a memo/tag — you don’t need one.',
  send: 'Send',
  sending: 'Sending…',
  cancel: 'Cancel',
  close: 'Close',
  p2pTitle: 'After it arrives on the exchange',
  p2p:
    'Sell your USDC (or convert to USDT) and cash out in XAF via P2P — MTN Mobile Money or Orange Money. Use high-rating merchants and confirm the mobile-money payment is actually in your account before releasing.',
  invalidAddress: 'Enter a valid Sui address (0x followed by 64 hex characters).',
  overBalance: 'Amount exceeds your available balance.',
  successPrefix: 'Sent! Digest: ',
} as const;

type Coin = 'USDC' | 'SUI';

const SUI_ADDR_RE = /^0x[0-9a-fA-F]{64}$/;

export interface CashOutGuideProps {
  isOpen: boolean;
  onClose: () => void;
  availableUsdc: number;
  availableSui: number;
  onSend: (args: {
    toAddress: string;
    amount: number;
    coin: Coin;
  }) => Promise<{ digest?: string } | void>;
}

export function CashOutGuide({
  isOpen,
  onClose,
  availableUsdc,
  availableSui,
  onSend,
}: CashOutGuideProps) {
  const [coin, setCoin] = useState<Coin>('USDC');
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [ackChecksum, setAckChecksum] = useState(false);
  const [ackFromExchange, setAckFromExchange] = useState(false);
  const [ackNetwork, setAckNetwork] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const available = coin === 'USDC' ? availableUsdc : availableSui;
  const trimmed = toAddress.trim();
  const addressValid = SUI_ADDR_RE.test(trimmed);
  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= available;

  const checksumEcho = useMemo(() => {
    if (!addressValid) return null;
    return `${trimmed.slice(0, 6)}…${trimmed.slice(-6)}`;
  }, [trimmed, addressValid]);

  const canSend =
    addressValid &&
    amountValid &&
    ackChecksum &&
    ackFromExchange &&
    ackNetwork &&
    !sending;

  if (!isOpen) return null;

  const reset = () => {
    setToAddress('');
    setAmount('');
    setAckChecksum(false);
    setAckFromExchange(false);
    setAckNetwork(false);
    setResult(null);
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const res = await onSend({ toAddress: trimmed, amount: amountNum, coin });
      const digest = res && 'digest' in res ? res.digest : undefined;
      setResult(digest || 'submitted');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={STRINGS.title}
      onClick={handleClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{STRINGS.title}</h2>
            <p className="text-sm text-slate-500">{STRINGS.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label={STRINGS.close}
          >
            ✕
          </button>
        </div>

        {result ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center">
            <div className="text-2xl">✅</div>
            <p className="mt-1 break-all text-xs font-medium text-emerald-800">
              {STRINGS.successPrefix}
              {result}
            </p>
            <div className="mt-3 rounded-lg bg-white p-3 text-left text-xs text-slate-600">
              <p className="font-semibold text-slate-700">{STRINGS.p2pTitle}</p>
              <p className="mt-1">{STRINGS.p2p}</p>
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="mt-3 rounded-full bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              {STRINGS.close}
            </button>
          </div>
        ) : (
          <>
            {/* Asset toggle */}
            <div className="mb-3">
              <p className="mb-1.5 text-sm font-semibold text-slate-700">{STRINGS.asset}</p>
              <div className="flex gap-2">
                {(['USDC', 'SUI'] as Coin[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCoin(c)}
                    className={`flex-1 rounded-xl border px-3 py-2 text-sm ${
                      coin === c
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                    }`}
                  >
                    {c}
                    <span className="ml-1 text-xs opacity-70">
                      ({(c === 'USDC' ? availableUsdc : availableSui).toLocaleString(undefined, {
                        maximumFractionDigits: 4,
                      })})
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Destination address */}
            <div className="mb-3">
              <label className="mb-1 block text-sm font-semibold text-slate-700">
                {STRINGS.destination}
              </label>
              <textarea
                value={toAddress}
                onChange={(e) => setToAddress(e.target.value)}
                rows={2}
                placeholder="0x…"
                className="w-full resize-none rounded-xl border border-slate-300 p-2 font-mono text-sm focus:border-slate-500 focus:outline-none"
              />
              <p className="mt-1 text-xs text-slate-500">{STRINGS.destinationHint}</p>
              {trimmed.length > 0 && !addressValid && (
                <p className="mt-1 text-xs text-red-600">{STRINGS.invalidAddress}</p>
              )}
              {checksumEcho && (
                <p className="mt-1 font-mono text-xs text-slate-700">
                  → <span className="font-semibold">{checksumEcho}</span>
                </p>
              )}
            </div>

            {/* Amount */}
            <div className="mb-3">
              <label className="mb-1 block text-sm font-semibold text-slate-700">
                {STRINGS.amount}
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-xl border border-slate-300 p-2 text-sm focus:border-slate-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setAmount(String(available))}
                  className="rounded-xl border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:border-slate-400"
                >
                  {STRINGS.max}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setAmount(coin === 'USDC' ? '2' : '1')}
                className="mt-1 text-xs text-blue-600 hover:underline"
              >
                {STRINGS.testFirst}
              </button>
              {amount.length > 0 && !amountValid && (
                <p className="mt-1 text-xs text-red-600">{STRINGS.overBalance}</p>
              )}
            </div>

            {/* Confirmation checklist */}
            <div className="mb-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <p className="mb-2 text-sm font-semibold text-slate-700">{STRINGS.checklistTitle}</p>
              {[
                { checked: ackChecksum, set: setAckChecksum, label: STRINGS.confirmChecksum },
                { checked: ackFromExchange, set: setAckFromExchange, label: STRINGS.confirmFromExchange },
                { checked: ackNetwork, set: setAckNetwork, label: STRINGS.confirmNetwork },
              ].map((row, i) => (
                <label key={i} className="mb-2 flex items-start gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={row.checked}
                    onChange={(e) => row.set(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>{row.label}</span>
                </label>
              ))}
              <p className="mt-1 rounded-lg bg-blue-50 p-2 text-xs text-blue-800">{STRINGS.noMemo}</p>
            </div>

            {error && (
              <p className="mb-3 rounded-lg bg-red-50 p-2 text-xs text-red-700">{error}</p>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleClose}
                className="flex-1 rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                {STRINGS.cancel}
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className="flex-1 rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white enabled:hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sending ? STRINGS.sending : STRINGS.send}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default CashOutGuide;
