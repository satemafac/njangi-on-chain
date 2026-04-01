import React from 'react';
import { AlertTriangle, CheckCircle2, CircleDot } from 'lucide-react';

interface RecoveryStateBadgeProps {
  rawState?: number | null;
  stateLabel?: string | null;
  className?: string;
}

export function RecoveryStateBadge({
  rawState,
  stateLabel,
  className = '',
}: RecoveryStateBadgeProps) {
  const resolvedLabel =
    stateLabel || (rawState === 3 ? 'Refunded' : rawState === 2 ? 'Stopped' : rawState === 1 ? 'Proposal Pending' : 'Active');
  const toneClass =
    rawState === 3
      ? 'bg-emerald-100 text-emerald-800'
      : rawState === 2
        ? 'bg-red-100 text-red-800'
        : rawState === 1
          ? 'bg-amber-100 text-amber-800'
          : 'bg-slate-100 text-slate-700';
  const Icon = rawState === 3 ? CheckCircle2 : rawState === 2 ? AlertTriangle : CircleDot;

  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${toneClass} ${className}`.trim()}
      aria-label={`Recovery state: ${resolvedLabel}`}
    >
      <Icon className="mr-1.5 h-3.5 w-3.5" />
      {resolvedLabel}
    </span>
  );
}
