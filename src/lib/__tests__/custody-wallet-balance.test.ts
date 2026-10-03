/**
 * Deleting a circle whose custody wallet still holds funds is refused on
 * chain: `njangi_circles::delete_circle` asserts the wallet's SUI balance is
 * zero and that it holds no stablecoin, both with EInsufficientDeposit (6) —
 * in the current source and in the original package's on-chain bytecode. The
 * app is meant to say so in plain words ("withdraw the funds first"); it
 * never did, for two reasons these pin down:
 *
 *   - the pre-check read the wallet's `Balance<SUI>` as `{ fields: { value } }`,
 *     but JSON-RPC renders it as a plain string, so it saw no balance;
 *   - the delete is signed in the browser, so the refusal arrives as the SDK's
 *     dry-run error, which nothing recognised.
 */
import {
  isDeleteCircleWalletFundsAbort,
  readBalanceField,
} from '@/lib/custody-wallet-balance';

describe('readBalanceField', () => {
  it('reads the plain string JSON-RPC renders a Balance<T> as', () => {
    expect(readBalanceField('1500000000')).toBe(1_500_000_000n);
    expect(readBalanceField('0')).toBe(0n);
  });

  it('still reads the nested { fields: { value } } and { value } forms', () => {
    expect(readBalanceField({ fields: { value: '42' } })).toBe(42n);
    expect(readBalanceField({ value: '42' })).toBe(42n);
    expect(readBalanceField(42)).toBe(42n);
  });

  it('is null (unknown), never 0, for anything that is not a balance', () => {
    for (const raw of [undefined, null, '', '-5', '1.5', 'abc', { amount: '5' }, [5], -5, 1.5]) {
      expect(readBalanceField(raw)).toBeNull();
    }
  });
});

describe('isDeleteCircleWalletFundsAbort', () => {
  // The SDK's error when build() dry-runs an aborting transaction, verbatim
  // in shape (captured on testnet 2026-10-03, `finalize_and_redeem` → 205),
  // with the module, function and code of the delete refusal.
  const dryRunAbort = (module: string, fn: string, code: number) =>
    'Dry run failed, could not automatically determine a budget: ' +
    `MoveAbort(MoveLocation { module: ModuleId { address: f8afd3dfcf94f152ec9d1f8cb870b77525353a20564bb0224bcad5520d621614, name: Identifier("${module}") }, function: 40, instruction: 78, function_name: Some("${fn}") }, ${code}) in command 0`;

  it('recognises delete_circle refusing a wallet that holds funds', () => {
    expect(isDeleteCircleWalletFundsAbort(dryRunAbort('njangi_circles', 'delete_circle', 6))).toBe(
      true,
    );
  });

  it('recognises the same abort from an executed transaction', () => {
    const executed = dryRunAbort('njangi_circles', 'delete_circle', 6).replace(
      'Dry run failed, could not automatically determine a budget: ',
      '',
    );
    expect(isDeleteCircleWalletFundsAbort(executed)).toBe(true);
  });

  it("ignores delete_circle's other refusals", () => {
    // 5: members, contributions or deposits; 7: not the admin; 46: wrong wallet.
    for (const code of [5, 7, 46]) {
      expect(
        isDeleteCircleWalletFundsAbort(dryRunAbort('njangi_circles', 'delete_circle', code)),
      ).toBe(false);
    }
  });

  it('ignores a 6 from any other function or module', () => {
    expect(isDeleteCircleWalletFundsAbort(dryRunAbort('njangi_circles', 'activate_circle', 6))).toBe(
      false,
    );
    expect(isDeleteCircleWalletFundsAbort(dryRunAbort('njangi_milestones', 'delete_circle', 6))).toBe(
      false,
    );
    expect(isDeleteCircleWalletFundsAbort('Something went wrong')).toBe(false);
  });
});
