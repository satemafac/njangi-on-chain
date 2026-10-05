// round-member-status.ts — The signed-in member's part in the round the
// round panel shows, for the contribute page around it.
//
// The page's payment status used to come from the legacy member row's
// `last_contribution`, which the per-round escrow never writes. A member who
// had paid kept reading "Ready" and "You can continue with payment." while
// the panel above said their share was in (production circle 0xa3fada…675ed,
// 2026-10-05). The panel reads the escrow itself (who paid, who collects,
// whether a round is open) and hands this status up, so the page and the
// panel cannot disagree.

import type { EscrowStage } from './cycle-escrow-collect';

export type RoundMemberStatus =
  /** The round is still being read. */
  | 'checking'
  /** The read failed. Nothing is known, so nothing may be claimed. */
  | 'unknown'
  /** No round is open. */
  | 'no-round'
  /** This round pays the viewer; they pay nothing into it. */
  | 'recipient'
  /** The viewer's share is in. */
  | 'paid'
  /** The viewer still owes this round's share. */
  | 'due'
  /** The round is open, but its member list does not include the viewer. */
  | 'not-in-round'
  /** The round was collected, refunded or is past its claim window. */
  | 'nothing-due';

export function resolveRoundMemberStatus(params: {
  stage: EscrowStage;
  /** The panel's last read failed (it then shows the stage as no round). */
  loadError: boolean;
  /** The viewer is on the escrow's contributor list. */
  userHasPaid: boolean;
  /** The viewer is the escrow's recipient. */
  isUserRecipient: boolean;
  /**
   * The viewer is on the escrow snapshot's member list. Null when the list
   * was not read, which counts as a member: only a list that was read and
   * leaves them out may say they owe nothing.
   */
  isRoundMember: boolean | null;
}): RoundMemberStatus {
  const { stage, loadError, userHasPaid, isUserRecipient, isRoundMember } = params;
  if (stage === 'loading') return 'checking';
  if (loadError) return 'unknown';
  switch (stage) {
    case 'no-round-open':
      return 'no-round';
    case 'completed':
    case 'refunded':
    case 'claim-expired':
      return 'nothing-due';
    case 'in-progress':
    case 'full-waiting-for-claim':
      if (isUserRecipient) return 'recipient';
      if (userHasPaid) return 'paid';
      // A full pot has every member's share, so an unpaid viewer is not in
      // the round; neither is one its member list leaves out.
      if (stage === 'full-waiting-for-claim' || isRoundMember === false) return 'not-in-round';
      return 'due';
  }
}

export interface RoundMemberStatusCopy {
  /** The short status: the payment tag and tile. */
  label: string;
  /** One sentence under the label on the payment readiness card. */
  detail: string;
  /** The cycle tile's second line while the circle is running. */
  roundState: string;
}

const COPY: Record<RoundMemberStatus, RoundMemberStatusCopy> = {
  checking: {
    label: 'Checking…',
    detail: 'Checking this round…',
    roundState: 'Checking…',
  },
  unknown: {
    label: "Couldn't check",
    detail: "We couldn't check this round. Refresh to try again.",
    roundState: "Couldn't check",
  },
  'no-round': {
    label: 'No round open',
    detail: 'Nothing to pay until the next round opens.',
    roundState: 'Between rounds',
  },
  recipient: {
    label: 'Recipient',
    detail: 'No payment required this round. The payout is yours.',
    roundState: 'Round open',
  },
  paid: {
    label: 'Contributed',
    detail: 'Your share for this round is in.',
    roundState: 'Round open',
  },
  due: {
    label: 'Share due',
    detail: 'Pay your share in the round panel above.',
    roundState: 'Round open',
  },
  'not-in-round': {
    label: 'Not in this round',
    detail: "This round's member list doesn't include you, so there is nothing to pay.",
    roundState: 'Round open',
  },
  'nothing-due': {
    label: 'Nothing due',
    detail: 'Nothing to pay until the next round opens.',
    roundState: 'Between rounds',
  },
};

export function roundMemberStatusCopy(status: RoundMemberStatus): RoundMemberStatusCopy {
  return COPY[status];
}
