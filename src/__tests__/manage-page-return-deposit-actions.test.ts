/**
 * NJA-3410 (part 2 of 2 of NJA-3333): the manage page's dead per-member
 * return-deposit actions.
 *
 * handleReturnSecurityDeposit and handleSecurityDepositPayout both POST
 * action 'returnSecurityDeposit' to /api/zkLogin, whose case answers
 * 410 CUSTODY_OP_REMOVED (src/pages/api/zkLogin.ts), so neither has ever
 * returned a deposit. handleSecurityDepositPayout lost its only caller in
 * part 1 (NJA-3409). handleReturnSecurityDeposit is still offered from the
 * admin-member branch of getMemberManagementAction ('Return deposit' /
 * 'Available when inactive or paused'). Two sentences still point the
 * organizer at the batch return part 1 removed. The remove-member path
 * (handleRemoveMember, 'Return deposit and remove') stays as it is.
 *
 * Source-text assertions, as in manage-page-return-deposit-controls.test.ts:
 * jest runs testEnvironment node and matches only .test.ts, so the .tsx page
 * can be neither imported nor rendered here.
 */
import { readFileSync } from 'fs';
import path from 'path';

const MANAGE_PAGE = path.resolve(__dirname, '..', 'pages/circle/[id]/manage/index.tsx');

/** Comments explain the rule; they must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const managePage = stripComments(readFileSync(MANAGE_PAGE, 'utf8'));

describe('manage page: the dead per-member return-deposit actions (NJA-3410)', () => {
  it('posts no returnSecurityDeposit action (the API answers 410 CUSTODY_OP_REMOVED)', () => {
    expect(managePage).not.toContain("action: 'returnSecurityDeposit'");
    // lower-case r: the dispatcher action string, not the handler names.
    expect(managePage).not.toContain('returnSecurityDeposit');
  });

  it('no longer defines handleSecurityDepositPayout, unused since part 1', () => {
    expect(managePage).not.toMatch(/const handleSecurityDepositPayout\b/);
  });

  it('no longer defines handleReturnSecurityDeposit or offers it from the roster', () => {
    expect(managePage).not.toMatch(/const handleReturnSecurityDeposit\b/);
    expect(managePage).not.toContain('handleReturnSecurityDeposit(member.address)');
    expect(managePage).not.toContain(
      "canReturnDeposit ? 'Return deposit' : 'Available when inactive or paused'",
    );
  });

  it('renders no sentence pointing at a batch return', () => {
    expect(managePage).not.toContain('manage deposits above for a batch return');
    expect(managePage).not.toContain('use the deposit manager to return all');
    expect(managePage).toContain(
      'This circle is inactive. Manage individual member actions from the Members table.',
    );
  });

  it('drops the state only the batch payout used', () => {
    for (const name of [
      'isProcessingPayout',
      'payoutProgress',
      'showPayoutDepositModal',
      'selectedMembersForPayout',
      'paidOutInCurrentSessionMembers',
    ]) {
      expect(managePage).not.toContain(name);
    }
  });

  it('keeps the remove-member action, its deposit wording and the Deposit Management card', () => {
    expect(managePage).toContain("'Return deposit and remove'");
    expect(managePage).toContain('onClick: () => handleRemoveMember(member.address)');
    expect(managePage).toContain('Deposit Management');
  });
});
