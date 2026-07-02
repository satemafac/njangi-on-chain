// ReceiveFundsModal.tsx — the PRIMARY funding flow.
//
// Njangi On-Chain is non-custodial: users fund their in-app zkLogin Sui wallet
// by withdrawing USDC directly from a centralized exchange over the Sui
// network. There is no fiat ramp in this path. This modal shows the wallet
// address (QR + copy), pins the correct network, walks the user through their
// exchange, and watches for the incoming transfer so a first-timer never
// stares at a static screen wondering if it worked.
//
// VERIFIED FACTS encoded below (live-checked 2026-07):
//   - USDC withdrawal over the Sui network works on Binance, Coinbase, OKX,
//     Bybit, KuCoin, Gate, Kraken. It does NOT work on Bitget (no USDC-Sui
//     rail) — those users withdraw SUI and swap in-app instead.
//   - NO exchange supports USDT over the Sui network (Tether isn't issued on
//     Sui). Cameroon path: buy USDT on Binance P2P (XAF via MTN MoMo / Orange
//     Money) -> convert USDT->USDC on the exchange -> withdraw USDC on Sui.
//
// i18n TODO: strings are collected in STRINGS for a later extraction pass.

import React, { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

const STRINGS = {
  title: 'Add funds',
  subtitle: 'Transfer USDC from your exchange to this wallet',
  networkWarning:
    'Send only USDC over the Sui network. Sending a different asset or network can permanently lose your funds.',
  yourAddress: 'Your Sui wallet address',
  copy: 'Copy address',
  copied: 'Address copied',
  chooseExchange: 'Where are your funds?',
  steps: 'Steps',
  testFirst:
    'Sending for the first time? Send a small test amount (e.g. 2 USDC) first, confirm it arrives below, then send the rest.',
  minFee:
    'Check your exchange’s minimum withdrawal and network fee before sending — fund monthly in one transfer to keep fees small.',
  watching: 'Watching for your transfer…',
  arrivedPrefix: 'Received ',
  arrivedSuffix: ' USDC — you’re funded!',
  done: 'Done',
  close: 'Close',
} as const;

type ExchangeId = 'binance' | 'coinbase' | 'okx' | 'bybit' | 'kucoin' | 'other';

interface ExchangeGuide {
  id: ExchangeId;
  label: string;
  /** Whether this exchange can withdraw USDC over the Sui network. */
  usdcOverSui: boolean;
  steps: string[];
  note?: string;
}

const EXCHANGES: ExchangeGuide[] = [
  {
    id: 'binance',
    label: 'Binance',
    usdcOverSui: true,
    steps: [
      'Open Binance → Wallet → Withdraw → select USDC.',
      'Paste your address (below) as the recipient.',
      'For the network, choose “Sui”.',
      'Enter the amount and confirm.',
    ],
    note:
      'In Cameroon: buy USDT on Binance P2P (XAF via MTN MoMo / Orange Money), convert USDT → USDC in Spot, then withdraw USDC on the Sui network.',
  },
  {
    id: 'coinbase',
    label: 'Coinbase',
    usdcOverSui: true,
    steps: [
      'Open Coinbase → your USDC balance → Send.',
      'Paste your address (below) as the recipient.',
      'Choose the “Sui” network. Do not send on Ethereum/Base.',
      'Enter the amount and confirm.',
    ],
  },
  {
    id: 'okx',
    label: 'OKX',
    usdcOverSui: true,
    steps: [
      'Open OKX → Assets → Withdraw → USDC → On-chain.',
      'Paste your address (below).',
      'Select the “Sui” network.',
      'Enter the amount and confirm.',
    ],
  },
  {
    id: 'bybit',
    label: 'Bybit',
    usdcOverSui: true,
    steps: [
      'Open Bybit → Assets → Withdraw → USDC.',
      'Paste your address (below).',
      'Select the “Sui” network.',
      'Enter the amount and confirm.',
    ],
  },
  {
    id: 'kucoin',
    label: 'KuCoin',
    usdcOverSui: true,
    steps: [
      'Open KuCoin → Assets → Withdraw → USDC.',
      'Paste your address (below).',
      'Select the “Sui” network.',
      'Enter the amount and confirm.',
    ],
  },
  {
    id: 'other',
    label: 'Other exchange',
    usdcOverSui: false,
    steps: [
      'First check your exchange supports withdrawing USDC on the Sui network.',
      'If it does: withdraw USDC, paste your address, pick the Sui network.',
      'If it does NOT (e.g. Bitget): withdraw SUI instead, then use the in-app swap to convert a little SUI to USDC.',
    ],
    note:
      'No exchange can send USDT over Sui. If you only have USDT, convert it to USDC (or withdraw SUI) first.',
  },
];

function groupAddress(addr: string): string {
  if (!addr || addr.length < 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

export interface ReceiveFundsModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  /**
   * Optional live balance getter (USDC, in whole units). When provided, the
   * modal polls it while open and celebrates when the balance increases.
   */
  pollBalance?: () => Promise<number>;
  onArrived?: (newBalanceUsdc: number) => void;
}

export function ReceiveFundsModal({
  isOpen,
  onClose,
  walletAddress,
  pollBalance,
  onArrived,
}: ReceiveFundsModalProps) {
  const [copied, setCopied] = useState(false);
  const [exchange, setExchange] = useState<ExchangeId>('binance');
  const [arrivedAmount, setArrivedAmount] = useState<number | null>(null);
  const baselineRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Arrival watcher: capture a baseline when opened, then poll for an increase.
  useEffect(() => {
    if (!isOpen || !pollBalance) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const balance = await pollBalance();
        if (cancelled || !mountedRef.current) return;
        if (baselineRef.current === null) {
          baselineRef.current = balance;
        } else if (balance > baselineRef.current) {
          const delta = balance - baselineRef.current;
          setArrivedAmount(delta);
          onArrived?.(balance);
          return; // stop polling once funds land
        }
      } catch {
        // transient RPC error — keep polling
      }
      if (!cancelled) timer = setTimeout(tick, 8000);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isOpen, pollBalance, onArrived]);

  // Reset arrival state each time the modal is reopened.
  useEffect(() => {
    if (isOpen) {
      setArrivedAmount(null);
      baselineRef.current = null;
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => mountedRef.current && setCopied(false), 2200);
    } catch {
      /* clipboard denied — user can select the address manually */
    }
  };

  const active = EXCHANGES.find((e) => e.id === exchange) ?? EXCHANGES[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={STRINGS.title}
      onClick={onClose}
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
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label={STRINGS.close}
          >
            ✕
          </button>
        </div>

        {/* Arrival success state */}
        {arrivedAmount !== null && (
          <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center">
            <div className="text-2xl">🎉</div>
            <p className="mt-1 text-sm font-semibold text-emerald-800">
              {STRINGS.arrivedPrefix}
              {arrivedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              {STRINGS.arrivedSuffix}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-3 rounded-full bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              {STRINGS.done}
            </button>
          </div>
        )}

        {/* QR + address */}
        <div className="flex flex-col items-center rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="rounded-xl bg-white p-3 shadow-sm">
            <QRCodeSVG value={walletAddress} size={160} level="M" />
          </div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wider text-slate-500">
            {STRINGS.yourAddress}
          </p>
          <p className="mt-1 break-all text-center font-mono text-sm text-slate-800">
            {groupAddress(walletAddress)}
          </p>
          <button
            type="button"
            onClick={handleCopy}
            className="mt-3 w-full rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            {copied ? STRINGS.copied : STRINGS.copy}
          </button>
          {copied && (
            <p className="mt-2 break-all text-center font-mono text-[11px] text-slate-500">
              {walletAddress}
            </p>
          )}
        </div>

        {/* Non-dismissable network warning */}
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <span aria-hidden className="text-base">⚠️</span>
          <p className="text-xs font-medium text-amber-800">{STRINGS.networkWarning}</p>
        </div>

        {/* Exchange picker */}
        <div className="mt-4">
          <p className="mb-2 text-sm font-semibold text-slate-700">{STRINGS.chooseExchange}</p>
          <div className="flex flex-wrap gap-2">
            {EXCHANGES.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setExchange(e.id)}
                className={`rounded-full border px-3 py-1.5 text-sm ${
                  exchange === e.id
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                }`}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>

        {/* Steps for the chosen exchange */}
        <div className="mt-3 rounded-2xl border border-slate-200 p-4">
          {!active.usdcOverSui && (
            <div className="mb-3 rounded-lg bg-slate-100 p-2 text-xs text-slate-600">
              Not every exchange can send USDC over Sui. If yours can’t, withdraw SUI and swap a
              little to USDC in the app.
            </div>
          )}
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
            {active.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {active.note && (
            <p className="mt-3 rounded-lg bg-blue-50 p-2 text-xs text-blue-800">{active.note}</p>
          )}
        </div>

        {/* Guidance */}
        <p className="mt-3 text-xs text-slate-500">{STRINGS.testFirst}</p>
        <p className="mt-1 text-xs text-slate-500">{STRINGS.minFee}</p>

        {/* Live watcher hint */}
        {pollBalance && arrivedAmount === null && (
          <div className="mt-4 flex items-center justify-center gap-2 text-sm text-slate-500">
            <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-emerald-500" />
            {STRINGS.watching}
          </div>
        )}
      </div>
    </div>
  );
}

export default ReceiveFundsModal;
