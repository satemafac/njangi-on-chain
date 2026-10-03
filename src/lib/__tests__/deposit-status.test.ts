import {
  allDepositsHeldForRounds,
  depositsHeldButFlagsCleared,
  isDepositHeldForRounds,
} from '@/lib/deposit-status';

describe('isDepositHeldForRounds', () => {
  it('is satisfied when the deposit_paid flag is set', () => {
    expect(isDepositHeldForRounds({ depositPaid: true, depositBalanceRaw: 100000n })).toBe(true);
    // The flag alone is enough even if the balance read came back empty.
    expect(isDepositHeldForRounds({ depositPaid: true, depositBalanceRaw: 0n })).toBe(true);
    expect(isDepositHeldForRounds({ depositPaid: true })).toBe(true);
  });

  it('is satisfied when the flag is cleared but a balance is still held (resumed circle)', () => {
    // resume_cycle clears deposit_paid and leaves deposit_balance in custody.
    expect(isDepositHeldForRounds({ depositPaid: false, depositBalanceRaw: 100000n })).toBe(true);
    expect(isDepositHeldForRounds({ depositPaid: undefined, depositBalanceRaw: 1n })).toBe(true);
  });

  it('is NOT satisfied when the flag is cleared and nothing is held (never deposited)', () => {
    expect(isDepositHeldForRounds({ depositPaid: false, depositBalanceRaw: 0n })).toBe(false);
    expect(isDepositHeldForRounds({ depositPaid: false })).toBe(false);
    expect(isDepositHeldForRounds({})).toBe(false);
    expect(isDepositHeldForRounds({ depositPaid: null, depositBalanceRaw: null })).toBe(false);
  });
});

describe('allDepositsHeldForRounds', () => {
  it('requires at least one member', () => {
    expect(allDepositsHeldForRounds([])).toBe(false);
  });

  it('passes a lap-1 circle where every flag is set', () => {
    expect(
      allDepositsHeldForRounds([
        { depositPaid: true, depositBalanceRaw: 100000n },
        { depositPaid: true, depositBalanceRaw: 100000n },
        { depositPaid: true, depositBalanceRaw: 100000n },
      ]),
    ).toBe(true);
  });

  it('passes a resumed circle where every flag is cleared but balances are held', () => {
    expect(
      allDepositsHeldForRounds([
        { depositPaid: false, depositBalanceRaw: 100000n },
        { depositPaid: false, depositBalanceRaw: 100000n },
        { depositPaid: false, depositBalanceRaw: 100000n },
      ]),
    ).toBe(true);
  });

  it('fails when any member has neither the flag nor a held balance', () => {
    expect(
      allDepositsHeldForRounds([
        { depositPaid: true, depositBalanceRaw: 100000n },
        { depositPaid: false, depositBalanceRaw: 100000n },
        { depositPaid: false, depositBalanceRaw: 0n },
      ]),
    ).toBe(false);
  });
});

describe('depositsHeldButFlagsCleared', () => {
  it('identifies the resumed-circle state', () => {
    expect(
      depositsHeldButFlagsCleared([
        { depositPaid: false, depositBalanceRaw: 100000n },
        { depositPaid: false, depositBalanceRaw: 100000n },
      ]),
    ).toBe(true);
  });

  it('is false on a lap-1 circle where every flag is set', () => {
    expect(
      depositsHeldButFlagsCleared([
        { depositPaid: true, depositBalanceRaw: 100000n },
        { depositPaid: true, depositBalanceRaw: 100000n },
      ]),
    ).toBe(false);
  });

  it('is false when a member genuinely has no deposit', () => {
    expect(
      depositsHeldButFlagsCleared([
        { depositPaid: false, depositBalanceRaw: 100000n },
        { depositPaid: false, depositBalanceRaw: 0n },
      ]),
    ).toBe(false);
    expect(depositsHeldButFlagsCleared([])).toBe(false);
  });
});
