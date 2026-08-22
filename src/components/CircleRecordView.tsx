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
  const { summary, circles } = record;
  const hasHistory = circles.length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="border-b border-[#e6ddd1] pb-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8578]">
          Savings circle record
        </p>
        <h1 className="mt-2 text-2xl font-bold text-[#111827] sm:text-3xl">
          Participation record
        </h1>
        <p className="mt-2 break-all font-mono text-xs text-[#556070]" title={record.address}>
          {record.address}
        </p>
        <p className="mt-3 text-sm text-[#556070]">
          Generated {formatDate(record.generatedAtMs)} · {record.network}
        </p>
        {headerNote ? (
          <p className="mt-3 text-sm text-[#374151]">{headerNote}</p>
        ) : null}
      </header>

      {/* Summary. Every figure here is provable from the object ids below. */}
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile label="Circles joined" value={summary.circlesJoined} />
        <SummaryTile label="Payouts received" value={summary.payoutsReceived} />
        <SummaryTile
          label="Completed rounds"
          value={summary.completedRoundsAcrossCircles}
        />
        <SummaryTile
          label="Member since"
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
        A round only completes when every member has paid in full — the circle
        cannot move to the next person otherwise. Each completed round below is
        therefore a round that was fully funded.
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-bold uppercase tracking-wide text-[#111827]">
          Circles
        </h2>

        {!hasHistory ? (
          <p className="mt-3 rounded-xl border border-[#e6ddd1] bg-white p-4 text-sm text-[#556070]">
            No circles yet. Once you join one, your record starts building here.
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
                    {c.circleName || 'Untitled circle'}
                  </h3>
                  <span className="text-xs text-[#8a8578]">
                    Joined {formatDate(c.joinedAtMs)}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                  <Fact label="Completed rounds" value={String(c.completedRounds)} />
                  <Fact
                    label="Members"
                    value={c.memberCount != null ? String(c.memberCount) : '—'}
                  />
                  <Fact
                    label="Your turn"
                    value={
                      c.rotationPosition != null ? `#${c.rotationPosition}` : 'Not set'
                    }
                  />
                  <Fact
                    label="Payout"
                    value={
                      c.payoutRound != null
                        ? `Received (round ${c.payoutRound})`
                        : 'Turn not yet reached'
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
          <strong className="text-[#111827]">How to check this.</strong> Every
          figure above comes from public records on the Sui network. Open any
          circle link to read the same information directly, without relying on
          this page.
        </p>
        <p className="text-xs leading-relaxed text-[#556070]">
          This is a record of savings circle activity. It is not a credit
          report, not a score, and not an assessment of anyone&apos;s
          creditworthiness. It shows what happened; it does not rate the person
          it belongs to.
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
