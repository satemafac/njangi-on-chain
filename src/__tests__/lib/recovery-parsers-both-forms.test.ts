/**
 * Circles step 4b, part 2 (NJA-3571), condition (1) of legal matters LC-T-e821adc5 / LC-T-ac147cd8: the recovery
 * parsers read a CircleConfig to the same result whether it came from Sui GraphQL (plain JSON: an Option is null or
 * its value, a struct is a plain object) or from JSON-RPC (wrapped: a struct is { type, fields }, an Option is
 * { type, fields: { vec: [...] } }). getCircleConfigFields now lists over GraphQL first, so both forms reach them.
 * The parsers are not changed; these tests pin that they agree.
 */
import { parseRecoveryStatus } from '@/lib/recovery-liveness';
import { parseRecoveryStateValue } from '@/lib/circle-recovery-state';

const PKG = '0x2a';
const ADMIN = '0x00000000000000000000000000000000000000000000000000000000000000a1';
const DELEGATE = '0x00000000000000000000000000000000000000000000000000000000000000b2';
const VOTER = '0x00000000000000000000000000000000000000000000000000000000000000c3';

type Case = { recoveryState: number; nextInCommand: string | null; proposal: boolean };

const plainProposal = () => ({
  proposer: ADMIN,
  created_at: '1000',
  deadline: '605800',
  passed_at: null,
  yes_votes: '1',
  no_votes: '0',
  majority_threshold: '2',
  eligible_voters: [ADMIN, VOTER],
  votes: [{ voter: VOTER, approved: true, voted_at: '1500' }],
});

const wrappedProposal = () => ({
  type: `${PKG}::njangi_circle_config::RecoveryProposal`,
  fields: {
    proposer: ADMIN,
    created_at: '1000',
    deadline: '605800',
    passed_at: { type: '0x1::option::Option<u64>', fields: { vec: [] } },
    yes_votes: '1',
    no_votes: '0',
    majority_threshold: '2',
    eligible_voters: [ADMIN, VOTER],
    votes: [{ type: `${PKG}::njangi_circle_config::RecoveryVote`, fields: { voter: VOTER, approved: true, voted_at: '1500' } }],
  },
});

/** A CircleConfig as Sui GraphQL renders it. */
function graphqlForm(c: Case): Record<string, unknown> {
  return {
    recovery_state: c.recoveryState,
    recovery_state_updated_at: '1700000000000',
    next_in_command: c.nextInCommand,
    recovery_proposal: c.proposal ? plainProposal() : null,
    auto_release_enabled: true,
    auto_release_delay_ms: '2592000000',
    auto_release_start_time: '1700000000000',
  };
}

/** The same CircleConfig as JSON-RPC renders it. */
function jsonRpcForm(c: Case): Record<string, unknown> {
  return {
    recovery_state: c.recoveryState,
    recovery_state_updated_at: '1700000000000',
    next_in_command: { type: '0x1::option::Option<address>', fields: { vec: c.nextInCommand ? [c.nextInCommand] : [] } },
    recovery_proposal: {
      type: `0x1::option::Option<${PKG}::njangi_circle_config::RecoveryProposal>`,
      fields: { vec: c.proposal ? [wrappedProposal()] : [] },
    },
    auto_release_enabled: true,
    auto_release_delay_ms: '2592000000',
    auto_release_start_time: '1700000000000',
  };
}

const CASES: Array<[string, Case]> = [
  ['active, no delegate, no proposal', { recoveryState: 0, nextInCommand: null, proposal: false }],
  ['active, a delegate, no proposal', { recoveryState: 0, nextInCommand: DELEGATE, proposal: false }],
  ['proposal pending, no delegate', { recoveryState: 1, nextInCommand: null, proposal: true }],
  ['proposal pending, a delegate', { recoveryState: 1, nextInCommand: DELEGATE, proposal: true }],
  ['stopped', { recoveryState: 2, nextInCommand: DELEGATE, proposal: false }],
  ['refunded', { recoveryState: 3, nextInCommand: null, proposal: false }],
];

describe('the recovery parsers read a GraphQL and a JSON-RPC CircleConfig alike', () => {
  it.each(CASES)('parseRecoveryStatus: %s', (_name, c) => {
    const fromGraphql = parseRecoveryStatus(graphqlForm(c));
    const fromJsonRpc = parseRecoveryStatus(jsonRpcForm(c));
    expect(fromGraphql).toEqual(fromJsonRpc);
    expect(fromGraphql?.rawState).toBe(c.recoveryState);
    expect(fromGraphql?.nextInCommand).toBe(c.nextInCommand);
    if (c.proposal) {
      expect(fromGraphql?.proposal).toMatchObject({
        proposer: ADMIN,
        createdAt: 1000,
        deadline: 605800,
        passedAt: null,
        yesVotes: 1,
        noVotes: 0,
        majorityThreshold: 2,
        eligibleVoters: [ADMIN, VOTER],
        votes: [{ voter: VOTER, approved: true, votedAt: 1500 }],
      });
    } else {
      expect(fromGraphql?.proposal).toBeNull();
    }
  });

  it.each(CASES)('parseRecoveryStateValue: %s', (_name, c) => {
    expect(parseRecoveryStateValue(graphqlForm(c))).toBe(c.recoveryState);
    expect(parseRecoveryStateValue(jsonRpcForm(c))).toBe(c.recoveryState);
  });

  it('agrees on a passed proposal, whose passed_at is set', () => {
    const passedPlain = { ...graphqlForm({ recoveryState: 1, nextInCommand: null, proposal: true }) };
    passedPlain.recovery_proposal = { ...plainProposal(), passed_at: '2000' };
    const passedWrapped = jsonRpcForm({ recoveryState: 1, nextInCommand: null, proposal: true });
    const proposal = wrappedProposal();
    proposal.fields.passed_at = { type: '0x1::option::Option<u64>', fields: { vec: ['2000'] } } as never;
    passedWrapped.recovery_proposal = { type: '0x1::option::Option<x>', fields: { vec: [proposal] } };
    const a = parseRecoveryStatus(passedPlain);
    expect(a).toEqual(parseRecoveryStatus(passedWrapped));
    expect(a?.proposal?.passedAt).toBe(2000);
  });
});
