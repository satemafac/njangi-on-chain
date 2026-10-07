/**
 * Deposits come back to members through the emergency stop (proposed by the
 * admin, voted on by the members), the recovery it unlocks, the auto-release
 * after the admin goes quiet, and the admin's "Return Deposit & Remove
 * Member". All of them signed with the caller's own gas only, so a member
 * holding no SUI could not get their deposit back. These pin the requests
 * and the wiring that sends them.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { circleSponsorRequest } from '@/lib/recovery-sponsorship';

const CIRCLE = '0x' + 'd'.repeat(64);

describe('recovery sponsorship requests', () => {
  it('bills the circle the action works on', () => {
    expect(circleSponsorRequest('executeRecovery', CIRCLE)).toEqual({
      action: 'executeRecovery',
      context: { circleId: CIRCLE },
    });
  });
});

describe('zkLoginClient asks the sponsor first for recovery and deposit returns', () => {
  const source = readFileSync(join(process.cwd(), 'src/services/zkLoginClient.ts'), 'utf8');

  /** A class method's source, up to the next public method. */
  const methodSource = (name: string): string => {
    const start = source.indexOf(`public async ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n  public async ', start + 1);
    return source.slice(start, end > start ? end : undefined);
  };

  it.each([
    ['proposeEmergencyStop', 'proposeEmergencyStop'],
    ['voteEmergencyStop', 'voteEmergencyStop'],
    ['executeRecovery', 'executeRecovery'],
    ['triggerAutoRelease', 'triggerAutoRelease'],
    ['adminRemoveMember', 'returnDepositAndRemoveMember'],
    // The organizer's planned close between laps, and a member collecting
    // their own deposit afterwards: deposit returns, so they ask too.
    ['completeCircle', 'completeCircle'],
    ['claimOwnRefund', 'claimOwnRefund'],
  ])('%s passes its request', (method, action) => {
    expect(methodSource(method)).toContain(`circleSponsorRequest('${action}'`);
  });

  it.each([
    ['signLocallyWithBuilder', 'async function signLocallyWithBuilder('],
    ['sendSerializedTransaction', 'private async sendSerializedTransaction('],
  ])('%s tries the sponsor before signing with the member\'s own gas', (_name, signature) => {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('signer.signAndExecute(', start) + 1);
    expect(body).toContain('await sponsorFirst(');
  });

  it('raises for a sponsored transaction that landed but failed', () => {
    const start = source.indexOf('async function sponsorFirst(');
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, source.indexOf('\n}\n', start))).toContain(
      'assertTransactionSucceeded(sponsored)',
    );
  });
});
