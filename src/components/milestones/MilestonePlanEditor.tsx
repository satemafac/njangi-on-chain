// MilestonePlanEditor.tsx — Creation-time milestone sketch editor used
// by create-circle when the smart-goal type is selected. The circle
// doesn't exist on chain yet, so this captures an ordered outline
// (USD savings targets and/or date targets) with validation mirroring
// the contract's strictly-increasing rules. The sketch is saved locally
// on submit and pre-fills the on-chain MilestoneCreator on the circle's
// goals page, where the admin publishes it for real.

import React from 'react';
import { CalendarDays, Coins, Plus, Trash2 } from 'lucide-react';
import {
  MAX_DESCRIPTION_BYTES,
  MAX_MILESTONES,
  descriptionByteLength,
  validatePlanSketch,
  type MilestoneDraft,
} from './milestone-plan';

export interface MilestonePlanEditorProps {
  plan: MilestoneDraft[];
  onChange: (plan: MilestoneDraft[]) => void;
  /** Currency symbol for USD sketch amounts, e.g. "$". */
  currencySymbol?: string;
}

function toLocalDateTimeInput(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MilestonePlanEditor({
  plan,
  onChange,
  currencySymbol = '$',
}: MilestonePlanEditorProps) {
  const errors = plan.length > 0 ? validatePlanSketch(plan, { nowMs: Date.now() }) : [];

  const update = (index: number, patch: Partial<MilestoneDraft>) => {
    onChange(plan.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };
  const remove = (index: number) => {
    onChange(plan.filter((_, i) => i !== index));
  };
  const add = (kind: 'monetary' | 'time') => {
    onChange([
      ...plan,
      { kind, description: '', requiresVerification: false },
    ]);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-gray-600">
        Sketch the milestones your circle will celebrate along the way —
        savings totals reached together, or dates the circle keeps going
        until. You&rsquo;ll publish them on the circle&rsquo;s goals page right
        after it&rsquo;s created.
      </p>

      {plan.length > 0 ? (
        <ol className="space-y-3">
          {plan.map((entry, index) => (
            <li key={index} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                  {entry.kind === 'monetary' ? (
                    <Coins className="h-3.5 w-3.5" />
                  ) : (
                    <CalendarDays className="h-3.5 w-3.5" />
                  )}
                  Milestone {index + 1} ·{' '}
                  {entry.kind === 'monetary' ? 'Savings target' : 'Date target'}
                </span>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="rounded-full border border-gray-200 bg-white p-1.5 text-gray-400 transition-colors hover:text-red-600"
                  aria-label={`Remove milestone ${index + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <input
                    type="text"
                    value={entry.description}
                    onChange={(e) => update(index, { description: e.target.value })}
                    placeholder='What are we celebrating? e.g. "Halfway to our goal"'
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">
                    {descriptionByteLength(entry.description)}/{MAX_DESCRIPTION_BYTES}
                  </p>
                </div>
                {entry.kind === 'monetary' ? (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500">{currencySymbol}</span>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={entry.targetUsd ?? ''}
                      onChange={(e) => {
                        const parsed = parseFloat(e.target.value);
                        update(index, {
                          targetUsd: Number.isFinite(parsed) ? parsed : undefined,
                        });
                      }}
                      placeholder="Total saved together (USD)"
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>
                ) : (
                  <input
                    type="datetime-local"
                    value={toLocalDateTimeInput(entry.targetTimestampMs)}
                    onChange={(e) => {
                      const ms = e.target.value ? new Date(e.target.value).getTime() : undefined;
                      update(index, {
                        targetTimestampMs: Number.isFinite(ms ?? NaN) ? ms : undefined,
                      });
                    }}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                  />
                )}
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={entry.requiresVerification}
                    onChange={(e) => update(index, { requiresVerification: e.target.checked })}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  Needs admin confirmation before it completes
                </label>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => add('monetary')}
          disabled={plan.length >= MAX_MILESTONES}
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-4 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Savings milestone
        </button>
        <button
          type="button"
          onClick={() => add('time')}
          disabled={plan.length >= MAX_MILESTONES}
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-4 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Date milestone
        </button>
      </div>

      {errors.length > 0 ? (
        <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3">
          {errors.map((error, i) => (
            <li key={i} className="text-xs leading-5 text-amber-900">
              {error}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default MilestonePlanEditor;
