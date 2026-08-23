import React, { useEffect, useMemo, useState } from 'react';
import { Check, Clock, History, Info, Pencil, RotateCcw, Users } from 'lucide-react';
import {
  clampStartPosition,
  isSameMember,
  resolveMigrationSetupBlocker,
  type MigrationRatification,
} from '@/lib/circle-migration';

export interface MigrationPanelMember {
  address: string;
  /** Zero-based index in the rotation order. Undefined until a slot is set. */
  position?: number;
  status: 'active' | 'suspended' | 'exited';
}

interface CircleMigrationPanelProps {
  members: MigrationPanelMember[];
  adminAddress: string;
  memberNames?: Record<string, string>;
  shortenAddress: (address: string) => string;
  ratification: MigrationRatification | null;
  isBusy: boolean;
  onDeclare: (priorRoundsCompleted: number, startPosition: number) => void;
  onClear: () => void;
}

function label(
  address: string,
  adminAddress: string,
  memberNames: Record<string, string> | undefined,
  shortenAddress: (address: string) => string,
): string {
  const name = memberNames?.[address.toLowerCase()] ?? memberNames?.[address];
  const base = name && name.trim().length > 0 ? name : shortenAddress(address);
  return isSameMember(address, adminAddress) ? `${base} (you)` : base;
}

/**
 * Records where a circle that has been running elsewhere already stands, so it
 * can carry on here instead of restarting its rotation.
 *
 * The declaration is a claim about turns taken off this platform, and marking
 * a member as already collected takes them out of this round's payout queue.
 * Nothing happens on the strength of the organiser's word alone: the circle
 * cannot start until every member has confirmed the same picture, and any
 * change sends everyone back to confirm again.
 */
const CircleMigrationPanel: React.FC<CircleMigrationPanelProps> = ({
  members,
  adminAddress,
  memberNames,
  shortenAddress,
  ratification,
  isBusy,
  onDeclare,
  onClear,
}) => {
  const rotation = useMemo(
    () =>
      members
        .filter((member) => typeof member.position === 'number')
        .slice()
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    [members],
  );

  const [nextTurnIndex, setNextTurnIndex] = useState<number>(
    ratification?.ledger.startPosition ?? 1,
  );
  const [priorRounds, setPriorRounds] = useState<string>(
    String(ratification?.ledger.priorRoundsCompleted ?? 0),
  );
  const [isEditing, setIsEditing] = useState(false);

  // A successful re-declare bumps the ledger version; leave edit mode so the
  // freshly recorded state (and its reset confirmations) become visible. A
  // failed declare changes nothing, so the form stays open.
  const ledgerVersion = ratification?.ledger.version;
  useEffect(() => {
    setIsEditing(false);
  }, [ledgerVersion]);

  const beginEditing = () => {
    if (ratification) {
      setPriorRounds(String(ratification.ledger.priorRoundsCompleted));
      setNextTurnIndex(
        clampStartPosition(ratification.ledger.startPosition, rotation.length),
      );
    }
    setIsEditing(true);
  };

  const setupBlocker = resolveMigrationSetupBlocker(members.length, rotation.length);

  if (setupBlocker) {
    return (
      <div className="rounded-[16px] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <div className="flex items-start gap-2">
          <Info size={18} className="mt-0.5 shrink-0" />
          {setupBlocker === 'need-members' ? (
            <div>
              <p className="font-medium">Waiting for members to join</p>
              <p className="mt-1">
                A circle needs at least 3 members before its history can be
                recorded. Share the invite link and approve everyone who joins —
                this step unlocks as soon as they are in. Nobody has to pay a
                security deposit first.
              </p>
            </div>
          ) : (
            <div>
              <p className="font-medium">Assign the payout order first</p>
              <p className="mt-1">
                Everyone is in — now give each member a place in the rotation
                using Edit Rotation Order above. History points at those
                positions, so it can only be recorded once the order is set.
                Security deposits are not required for this step.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  const parsedPriorRounds = Number(priorRounds);
  const priorRoundsValid =
    Number.isInteger(parsedPriorRounds) && parsedPriorRounds >= 0 && parsedPriorRounds <= 1000;
  const declaresSomething = nextTurnIndex > 0 || parsedPriorRounds > 0;

  // ------------------------------------------------------------------
  // Declared and awaiting confirmations
  // ------------------------------------------------------------------
  if (ratification && !isEditing) {
    const { ledger, alreadyCollected, stillWaiting, nextRecipient, confirmed, pending } =
      ratification;

    return (
      <div className="space-y-4">
        {!ratification.matchesRotation && (
          <div className="rounded-[16px] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <div className="flex items-start gap-2">
              <Info size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">The payout order changed</p>
                <p className="mt-1">
                  Members confirmed a different queue, so what is shown below no
                  longer describes this circle. Record it again with the current
                  order — everyone will be asked to confirm the new one.
                </p>
                <button
                  type="button"
                  onClick={beginEditing}
                  disabled={isBusy}
                  className="mt-3 inline-flex items-center gap-2 rounded-[12px] border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCcw size={15} />
                  Record it again
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="rounded-[16px] border border-stone-200 bg-white p-4">
          <div className="flex items-center gap-2 text-slate-900">
            <History size={18} />
            <h4 className="font-semibold">Where this circle stands</h4>
          </div>

          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">
                Rounds completed before joining
              </dt>
              <dd className="mt-1 text-lg font-semibold text-slate-900">
                {ledger.priorRoundsCompleted}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">
                Turns taken this round
              </dt>
              <dd className="mt-1 text-lg font-semibold text-slate-900">
                {alreadyCollected.length} of {rotation.length}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Next to collect</dt>
              <dd className="mt-1 text-lg font-semibold text-slate-900">
                {nextRecipient
                  ? label(nextRecipient, adminAddress, memberNames, shortenAddress)
                  : '—'}
              </dd>
            </div>
          </dl>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-[12px] border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Already collected, off this platform
              </p>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                {alreadyCollected.length === 0 ? (
                  <li className="text-slate-500">Nobody yet</li>
                ) : (
                  alreadyCollected.map((address, index) => (
                    <li key={address}>
                      {index + 1}. {label(address, adminAddress, memberNames, shortenAddress)}
                    </li>
                  ))
                )}
              </ul>
            </div>
            <div className="rounded-[12px] border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Still to collect, here
              </p>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                {stillWaiting.map((address, index) => (
                  <li key={address}>
                    {alreadyCollected.length + index + 1}.{' '}
                    {label(address, adminAddress, memberNames, shortenAddress)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="rounded-[16px] border border-stone-200 bg-white p-4">
          <div className="flex items-center gap-2 text-slate-900">
            <Users size={18} />
            <h4 className="font-semibold">
              Confirmations ({confirmed.length} of {rotation.length})
            </h4>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            This is a record of turns taken elsewhere, so every member confirms it
            themselves before the circle starts. Each member confirms on their own
            contribute page: paying the security deposit counts as confirming, and
            anyone who already paid sees a &ldquo;Yes, this is right&rdquo; button
            there instead.
          </p>

          <ul className="mt-3 space-y-2">
            {rotation.map((member) => {
              const isConfirmed = confirmed.some((address) =>
                isSameMember(address, member.address),
              );
              return (
                <li
                  key={member.address}
                  className="flex items-center justify-between rounded-[12px] border border-stone-200 px-3 py-2 text-sm"
                >
                  <span className="text-slate-800">
                    {(member.position ?? 0) + 1}.{' '}
                    {label(member.address, adminAddress, memberNames, shortenAddress)}
                  </span>
                  {isConfirmed ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      <Check size={13} /> Confirmed
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                      <Clock size={13} /> Waiting
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {pending.length > 0 && (
            <p className="mt-3 rounded-[12px] bg-stone-50 px-3 py-2 text-sm text-slate-600">
              The circle cannot start until the remaining {pending.length}{' '}
              {pending.length === 1 ? 'member confirms' : 'members confirm'}.
            </p>
          )}
        </div>

        <div className="rounded-[16px] border border-stone-200 bg-stone-50 p-4">
          <p className="text-sm text-slate-600">
            Got this wrong? Changing it asks every member to confirm again, including
            those who already have.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={beginEditing}
              disabled={isBusy}
              className="inline-flex items-center gap-2 rounded-[12px] border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Pencil size={15} />
              Edit these details
            </button>
            <button
              type="button"
              onClick={onClear}
              disabled={isBusy}
              className="inline-flex items-center gap-2 rounded-[12px] border border-stone-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw size={15} />
              Start this circle from the beginning instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Nothing declared yet — or the admin is revising what was declared
  // ------------------------------------------------------------------
  const isRevisingDeclared = isEditing && ratification !== null;

  return (
    <div className="space-y-4">
      <div className="rounded-[16px] border border-stone-200 bg-white p-4">
        <div className="flex items-center gap-2 text-slate-900">
          <History size={18} />
          <h4 className="font-semibold">
            {isRevisingDeclared
              ? 'Update where this circle stands'
              : 'Has this circle already been running?'}
          </h4>
        </div>
        {isRevisingDeclared ? (
          <p className="mt-1 text-sm text-slate-600">
            Saving replaces the current record. Every member will be asked to
            confirm the new one, including anyone who already confirmed.
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-600">
            If your group has been going for a while, record where it is now and it
            will carry on from there. Leave this alone and the circle starts a fresh
            rotation with the first person in the order.
          </p>
        )}

        <div className="mt-4">
          <label
            htmlFor="prior-rounds"
            className="block text-sm font-medium text-slate-800"
          >
            Full rounds your group has already finished
          </label>
          <p className="mt-1 text-xs text-slate-500">
            A round is one pass through everybody. Put 0 if you are still in your
            first one.
          </p>
          <input
            id="prior-rounds"
            type="number"
            min={0}
            max={1000}
            value={priorRounds}
            onChange={(event) => setPriorRounds(event.target.value)}
            className="mt-2 w-32 rounded-[12px] border border-stone-300 px-3 py-2 text-sm text-slate-900"
          />
          {!priorRoundsValid && (
            <p className="mt-1 text-xs text-rose-600">
              Enter a whole number of completed rounds.
            </p>
          )}
        </div>

        <div className="mt-5">
          <p className="text-sm font-medium text-slate-800">Whose turn is next?</p>
          <p className="mt-1 text-xs text-slate-500">
            Everyone above your choice is recorded as having already collected in
            this round, and will not be paid again until the round ends.
          </p>

          <ul className="mt-3 space-y-2">
            {rotation.map((member, index) => {
              const collected = index < nextTurnIndex;
              return (
                <li key={member.address}>
                  <label
                    className={`flex cursor-pointer items-center justify-between rounded-[12px] border px-3 py-2 text-sm ${
                      index === nextTurnIndex
                        ? 'border-emerald-400 bg-emerald-50'
                        : 'border-stone-200 hover:bg-stone-50'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <input
                        type="radio"
                        name="next-turn"
                        checked={index === nextTurnIndex}
                        onChange={() => setNextTurnIndex(index)}
                        className="h-4 w-4"
                      />
                      <span className="text-slate-800">
                        {index + 1}.{' '}
                        {label(member.address, adminAddress, memberNames, shortenAddress)}
                      </span>
                    </span>
                    {collected && (
                      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-slate-600">
                        Already collected
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>

        {!declaresSomething && (
          <p className="mt-4 rounded-[12px] bg-stone-50 px-3 py-2 text-sm text-slate-600">
            With the first person still to collect and no finished rounds, this is an
            ordinary new circle — there is nothing to record.
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onDeclare(parsedPriorRounds, nextTurnIndex)}
            disabled={isBusy || !priorRoundsValid || !declaresSomething}
            className="inline-flex items-center gap-2 rounded-[12px] bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Record this and ask members to confirm
          </button>
          {isRevisingDeclared && (
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              disabled={isBusy}
              className="inline-flex items-center gap-2 rounded-[12px] border border-stone-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Keep what was recorded
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default CircleMigrationPanel;
