import React from 'react';
import type { RecoveryMemberRefundSummary } from '@/lib/recovery-execution';

interface RecoveryRefundTableProps {
  refunds: RecoveryMemberRefundSummary[];
  formatDate: (timestamp: number) => string;
  formatSuiAmount: (rawAmount: bigint) => string;
  formatStablecoinAmount: (rawAmount: bigint) => string;
  title?: string;
  emptyMessage?: string;
  maxItems?: number;
  className?: string;
}

const shortenAddress = (value: string): string => `${value.slice(0, 6)}...${value.slice(-4)}`;

export function RecoveryRefundTable({
  refunds,
  formatDate,
  formatSuiAmount,
  formatStablecoinAmount,
  title = 'Refund events',
  emptyMessage = 'No refund events have been emitted yet.',
  maxItems,
  className = '',
}: RecoveryRefundTableProps) {
  const rows = typeof maxItems === 'number' ? refunds.slice(0, maxItems) : refunds;

  return (
    <div className={`rounded-[24px] border border-stone-200 bg-white ${className}`.trim()}>
      <div className="border-b border-stone-200 px-4 py-3 sm:px-5">
        <p className="text-sm font-medium text-slate-900">{title}</p>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-4 text-sm leading-6 text-slate-600 sm:px-5">{emptyMessage}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm" aria-label={title}>
            <thead className="bg-stone-50 text-xs uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium sm:px-5">Member</th>
                <th className="px-4 py-3 font-medium sm:px-5">Refunded At</th>
                <th className="px-4 py-3 font-medium sm:px-5">SUI</th>
                <th className="px-4 py-3 font-medium sm:px-5">Stablecoin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200">
              {rows.map((refund) => (
                <tr key={`${refund.member}-${refund.timestamp}`} className="align-top">
                  <td className="px-4 py-3 font-mono font-medium text-slate-950 sm:px-5">
                    {shortenAddress(refund.member)}
                  </td>
                  <td className="px-4 py-3 text-slate-600 sm:px-5">{formatDate(refund.timestamp)}</td>
                  <td className="px-4 py-3 font-medium text-slate-950 sm:px-5">
                    {formatSuiAmount(refund.suiRefundRaw)}
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-950 sm:px-5">
                    {formatStablecoinAmount(refund.stablecoinRefundRaw)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
