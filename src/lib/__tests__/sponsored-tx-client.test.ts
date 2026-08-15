/**
 * The sponsor hands back full transaction bytes for the browser to sign. If the
 * client signed them unconditionally, the server would have regained the
 * arbitrary-signing oracle that Phase 0 removed — just by a longer route, and
 * with the user's own key. `assertSponsoredMatchesKind` is the only thing
 * standing between those two states, so it is tested against deliberately
 * tampered bytes rather than only the happy path.
 */
import { Transaction } from '@mysten/sui/transactions';
import type { SuiClient } from '@mysten/sui/client';
import { assertSponsoredMatchesKind } from '@/lib/sponsored-tx-client';

const USER = '0x' + 'a'.repeat(64);
const ATTACKER = '0x' + 'b'.repeat(64);
const SPONSOR = '0x' + 'c'.repeat(64);
const PKG = '0x' + '1'.repeat(64);

// Every input below is pure or an explicitly-versioned object ref, and gas data
// is set by hand, so building resolves nothing over the network.
const client = {} as SuiClient;

function objRef(id: string) {
  return { objectId: id, version: '1', digest: '11111111111111111111111111111111' };
}

function contributeCall(txb: Transaction) {
  txb.moveCall({
    target: `${PKG}::njangi_cycle_escrow::contribute`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      txb.objectRef(objRef('0x' + 'e'.repeat(64))),
      txb.objectRef(objRef('0x' + 'f'.repeat(64))),
    ],
  });
}

/**
 * The security-deposit shape, which is structurally different from a
 * contribution: coins are merged and split from an OWNED coin (never txb.gas,
 * which is what keeps it sponsorable at all), and the move call carries four
 * arguments including the Clock.
 *
 * Worth its own fixture because the comparator round-trips the sponsored bytes
 * back through `build({ onlyTransactionKind: true })` and demands byte
 * identity. If that is not stable for merge/split command shapes, every
 * sponsored deposit falls back to self-paid gas in silence — which looks
 * exactly like sponsorship never having been fixed.
 */
function depositCall(txb: Transaction) {
  const primary = txb.objectRef(objRef('0x' + '3'.repeat(64)));
  txb.mergeCoins(primary, [txb.objectRef(objRef('0x' + '4'.repeat(64)))]);
  const depositCoin = txb.splitCoins(primary, [txb.pure.u64(300000)]);
  txb.moveCall({
    target: `${PKG}::njangi_circles::member_deposit_security_deposit`,
    typeArguments: [`${PKG}::usdc::USDC`],
    arguments: [
      txb.objectRef(objRef('0x' + 'e'.repeat(64))),
      txb.objectRef(objRef('0x' + 'd'.repeat(64))),
      depositCoin,
      txb.objectRef(objRef('0x0000000000000000000000000000000000000000000000000000000000000006')),
    ],
  });
}

function withSponsorGas(txb: Transaction, sender: string) {
  txb.setSender(sender);
  txb.setGasOwner(SPONSOR);
  txb.setGasPrice(1000);
  txb.setGasBudget(50_000_000);
  txb.setGasPayment([objRef('0x' + '9'.repeat(64))]);
}

async function buildKind(fill: (txb: Transaction) => void): Promise<Uint8Array> {
  const txb = new Transaction();
  fill(txb);
  return txb.build({ client, onlyTransactionKind: true });
}

async function buildSponsored(
  fill: (txb: Transaction) => void,
  sender = USER,
): Promise<Uint8Array> {
  const txb = new Transaction();
  fill(txb);
  withSponsorGas(txb, sender);
  return txb.build({ client });
}

describe('assertSponsoredMatchesKind', () => {
  it('accepts bytes that differ from the built kind only by gas data', async () => {
    const kind = await buildKind(contributeCall);
    const sponsored = await buildSponsored(contributeCall);

    await expect(
      assertSponsoredMatchesKind(sponsored, kind, USER, client),
    ).resolves.toBeUndefined();
  });

  it('refuses when the sponsor swapped in a different sender', async () => {
    // Signing this would authorize a transaction attributed to someone else.
    const kind = await buildKind(contributeCall);
    const sponsored = await buildSponsored(contributeCall, ATTACKER);

    await expect(
      assertSponsoredMatchesKind(sponsored, kind, USER, client),
    ).rejects.toThrow(/does not match this session/);
  });

  it('refuses when the sponsor appended an extra move call', async () => {
    // The realistic attack: keep the expected call so the transaction looks
    // right, and smuggle a second one in behind it.
    const kind = await buildKind(contributeCall);
    const sponsored = await buildSponsored((txb) => {
      contributeCall(txb);
      txb.moveCall({
        target: `${PKG}::njangi_circles::delete_circle`,
        arguments: [txb.objectRef(objRef('0x' + 'd'.repeat(64)))],
      });
    });

    await expect(
      assertSponsoredMatchesKind(sponsored, kind, USER, client),
    ).rejects.toThrow(/does not match the transaction this client built/);
  });

  it('refuses when the sponsor altered an argument', async () => {
    // Same shape, same target, different object — e.g. a redirected payment.
    const kind = await buildKind(contributeCall);
    const sponsored = await buildSponsored((txb) => {
      txb.moveCall({
        target: `${PKG}::njangi_cycle_escrow::contribute`,
        typeArguments: ['0x2::sui::SUI'],
        arguments: [
          txb.objectRef(objRef('0x' + 'e'.repeat(64))),
          txb.objectRef(objRef('0x' + '7'.repeat(64))), // different coin
        ],
      });
    });

    await expect(
      assertSponsoredMatchesKind(sponsored, kind, USER, client),
    ).rejects.toThrow(/does not match the transaction this client built/);
  });

  it('refuses when the sponsor changed the move target', async () => {
    const kind = await buildKind(contributeCall);
    const sponsored = await buildSponsored((txb) => {
      txb.moveCall({
        target: `${PKG}::njangi_cycle_escrow::finalize_and_redeem`,
        typeArguments: ['0x2::sui::SUI'],
        arguments: [
          txb.objectRef(objRef('0x' + 'e'.repeat(64))),
          txb.objectRef(objRef('0x' + 'f'.repeat(64))),
        ],
      });
    });

    await expect(
      assertSponsoredMatchesKind(sponsored, kind, USER, client),
    ).rejects.toThrow(/does not match the transaction this client built/);
  });

  it('compares sender case-insensitively so address casing is not a false alarm', async () => {
    const kind = await buildKind(contributeCall);
    const sponsored = await buildSponsored(contributeCall, USER.toUpperCase().replace('0X', '0x'));

    await expect(
      assertSponsoredMatchesKind(sponsored, kind, USER, client),
    ).resolves.toBeUndefined();
  });

  it('accepts a security-deposit kind, whose merge/split shape differs from a contribution', async () => {
    // The test that decides whether sponsored deposits work at all.
    const kind = await buildKind(depositCall);
    const sponsored = await buildSponsored(depositCall);

    await expect(
      assertSponsoredMatchesKind(sponsored, kind, USER, client),
    ).resolves.toBeUndefined();
  });

  it('still refuses a tampered security-deposit kind', async () => {
    // Acceptance above must not come from the comparator going slack on this
    // shape: the same fixture with one argument altered has to fail.
    const kind = await buildKind(depositCall);
    const tampered = await buildSponsored((txb) => {
      const primary = txb.objectRef(objRef('0x' + '3'.repeat(64)));
      txb.mergeCoins(primary, [txb.objectRef(objRef('0x' + '4'.repeat(64)))]);
      const depositCoin = txb.splitCoins(primary, [txb.pure.u64(300000)]);
      txb.moveCall({
        target: `${PKG}::njangi_circles::member_deposit_security_deposit`,
        typeArguments: [`${PKG}::usdc::USDC`],
        arguments: [
          // circle swapped for one the member did not agree to fund
          txb.objectRef(objRef('0x' + 'b'.repeat(64))),
          txb.objectRef(objRef('0x' + 'd'.repeat(64))),
          depositCoin,
          txb.objectRef(objRef('0x0000000000000000000000000000000000000000000000000000000000000006')),
        ],
      });
    });

    await expect(
      assertSponsoredMatchesKind(tampered, kind, USER, client),
    ).rejects.toThrow();
  });
});
