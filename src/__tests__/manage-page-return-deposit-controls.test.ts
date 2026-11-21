/**
 * NJA-3409 (part 1 of 2 of NJA-3333): the manage page's dead return-deposit
 * controls.
 *
 * The two "Manage Deposits" buttons open SecurityDepositPayoutModal, whose
 * "Return Deposit" action reaches the 'returnSecurityDeposit' case of
 * /api/zkLogin, which answers 410 CUSTODY_OP_REMOVED (src/pages/api/zkLogin.ts).
 * The controls therefore never work. Part 1 removes the modal component, its
 * render, openReturnAllDepositsModal and both buttons. The remove-member path
 * (handleRemoveMember, 'Return deposit and remove') stays as it is.
 *
 * Source-text assertions, as in src/__tests__/whatsapp-card-recipient.test.ts:
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

describe('manage page: the dead return-deposit controls (NJA-3409)', () => {
  it('renders no "Manage Deposits" control', () => {
    // Both buttons and the modal header carry this label; the roster note at
    // the Members table says "manage deposits" in lower case and is not this.
    expect(managePage).not.toMatch(/Manage Deposits/);
    expect(managePage).not.toMatch(/onClick=\{openReturnAllDepositsModal\}/);
  });

  it('no longer has an opener for the batch-return dialog', () => {
    expect(managePage).not.toContain('openReturnAllDepositsModal');
  });

  it('neither defines nor renders SecurityDepositPayoutModal', () => {
    expect(managePage).not.toContain('<SecurityDepositPayoutModal />');
    expect(managePage).not.toMatch(/const SecurityDepositPayoutModal\b/);
  });

  it('keeps the remove-member action and its deposit wording', () => {
    expect(managePage).toMatch(/const handleRemoveMember = async \(memberAddress: string\)/);
    expect(managePage).toContain("'Return deposit and remove'");
    expect(managePage).toContain('onClick: () => handleRemoveMember(member.address)');
  });
});
