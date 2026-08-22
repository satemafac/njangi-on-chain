// CircleRecordView — the presentational half of Circle Record, shared by
// the member's own page and the read-only shared view.
//
// COPY DISCIPLINE (this is a compliance boundary, not a style choice):
//
//   * No score, rating, tier or grade appears anywhere. Facts only.
//   * No NEGATIVE claim is ever rendered. We show what completed; we never
//     assert that someone missed anything, because a false accusation is
//     the worst bug this feature could ship.
//   * The page says in plain words that this is not a credit report, so a
//     recipient cannot mistake it for one.
//   * Object ids are shown so the reader can verify against the public
//     ledger instead of trusting our rendering.

import { useTranslation } from '@/hooks/useTranslation';
import type { CircleRecord } from '@/lib/circle-record';

function formatDate(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function shorten(id: string): string {
  return id.length <= 18 ? id : `${id.slice(0, 10)}…${id.slice(-6)}`;
}

function explorerUrl(id: string, network: string): string {
  return `https://suiexplorer.com/object/${id}?network=${network}`;
}

export interface CircleRecordViewProps {
  record: CircleRecord;
  /** Shown on the member's own page; hidden on a shared view. */
  headerNote?: string;
}

export function CircleRecordView({ record, headerNote }: CircleRecordViewProps) {
  const { t } = useTranslation();
  const { summary, circles } = record;
  const hasHistory = circles.length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="border-b border-[#e6ddd1] pb-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8578]">
          {t('record.eyebrow')}
        </p>
        <h1 className="mt-2 text-2xl font-bold text-[#111827] sm:text-3xl">
          {t('record.title')}
        </h1>
        <p className="mt-2 break-all font-mono text-xs text-[#556070]" title={record.address}>
          {record.address}
        </p>
        <p className="mt-3 text-sm text-[#556070]">
          {t('record.generated', { date: formatDate(record.generatedAtMs), network: record.network })}
        </p>
        {headerNote ? (
          <p className="mt-3 text-sm text-[#374151]">{headerNote}</p>
        ) : null}
      </header>

      {/* Summary. Every figure here is provable from the object ids below. */}
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile label={t('record.summary.circlesJoined')} value={summary.circlesJoined} />
        <SummaryTile label={t('record.summary.payoutsReceived')} value={summary.payoutsReceived} />
        <SummaryTile
          label={t('record.summary.completedRounds')}
          value={summary.completedRoundsAcrossCircles}
        />
        <SummaryTile
          label={t('record.summary.memberSince')}
          value={
            summary.earliestJoinedAtMs
              ? new Date(summary.earliestJoinedAtMs).getFullYear().toString()
              : '—'
          }
        />
      </section>

      {/* The sentence that gives every number above its meaning. Without it
          "completed rounds" is just a count; with it, it is evidence. */}
      <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-900">
        {t('record.fullFundingNote')}
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-bold uppercase tracking-wide text-[#111827]">
          {t('record.circles.heading')}
        </h2>

        {!hasHistory ? (
          <p className="mt-3 rounded-xl border border-[#e6ddd1] bg-white p-4 text-sm text-[#556070]">
            {t('record.circles.empty')}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {circles.map((c) => (
              <li
                key={c.circleId}
                className="rounded-xl border border-[#e6ddd1] bg-white p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-base font-semibold text-[#111827]">
                    {c.circleName || t('record.circle.untitled')}
                  </h3>
                  <span className="text-xs text-[#8a8578]">
                    {t('record.circle.joined', { date: formatDate(c.joinedAtMs) })}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                  <Fact label={t('record.circle.completedRounds')} value={String(c.completedRounds)} />
                  <Fact
                    label={t('record.circle.members')}
                    value={c.memberCount != null ? String(c.memberCount) : '—'}
                  />
                  <Fact
                    label={t('record.circle.yourTurn')}
                    value={
                      c.rotationPosition != null
                        ? `#${c.rotationPosition}`
                        : t('record.circle.turnNotSet')
                    }
                  />
                  <Fact
                    label={t('record.circle.payout')}
                    value={
                      c.payoutRound != null
                        ? t('record.circle.payoutReceived', { round: c.payoutRound })
                        : t('record.circle.payoutNotYet')
                    }
                  />
                </dl>

                <a
                  href={explorerUrl(c.circleId, record.network)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-block break-all font-mono text-[11px] text-[#2E3C8F] underline"
                >
                  {shorten(c.circleId)}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-8 space-y-3 border-t border-[#e6ddd1] pt-6">
        <p className="text-xs leading-relaxed text-[#556070]">
          <strong className="text-[#111827]">{t('record.verify.title')}</strong>{' '}
          {t('record.verify.body')}
        </p>
        <p className="text-xs leading-relaxed text-[#556070]">
          {t('record.disclaimer')}
        </p>
      </footer>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[#e6ddd1] bg-white p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[#8a8578]">
        {label}
      </p>
      <p className="mt-1 text-xl font-bold tabular-nums text-[#111827]">{value}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-[#8a8578]">
        {label}
      </dt>
      <dd className="mt-0.5 text-[#111827]">{value}</dd>
    </div>
  );
}

export default CircleRecordView;
