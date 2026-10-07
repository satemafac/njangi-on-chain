import { Transaction } from '@mysten/sui/transactions';
import { allowedMoveCallTargets } from '@/lib/gas-sponsorship';
import {
  buildAdminRemoveMemberAssetTx,
  buildAdoptAssetPolicyTx,
  buildClaimOwnRefundTx,
  buildCompleteCircleTx,
  buildCreateCircleWithAssetTx,
  buildOpenRoundTx,
  buildPostSecurityDepositTx,
  buildRefundAssetTx,
  buildReleaseInvalidRoundTx,
  coinTypeFromTypeNameBytes,
  getAssetRegistryId,
  InsufficientCoinBalanceError,
  isSuiCoinType,
  nativeTermsForCreate,
  parseCircleAssetPolicy,
  readCircleAssetPolicy,
  readCircleCompletion,
  type V11CircleAssetPolicy,
} from '@/lib/v11-circle-tx';
import type { CreateCircleTransactionData } from '@/lib/zklogin-tx-builders';

const ADDR = (b: string) => `0x${b.repeat(64)}`;
const PKG = ADDR('a');
const REGISTRY = ADDR('b');
const CIRCLE = ADDR('c');
const WALLET = ADDR('d');
const MEMBER = ADDR('e');
const USDC_BYTES = `${'26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc'}::usdc::USDC`;
const USDC = `0x${USDC_BYTES}`;
const SUI_BYTES = `${'0'.repeat(63)}2::sui::SUI`;

const bytes = (text: string) => Array.from(text).map((c) => c.charCodeAt(0));

const circleData = (): CreateCircleTransactionData => ({
  name: 'Pinned circle',
  contribution_amount: '0',
  contribution_amount_local: 1000,
  contribution_amount_usd: 1000,
  currency_type: 'USD',
  security_deposit: '0',
  security_deposit_local: 500,
  security_deposit_usd: 500,
  cycle_length: 0,
  cycle_day: 1,
  circle_type: 0,
  max_members: 5,
  rotation_style: 0,
  penalty_rules: [false, false],
  verification_required: false,
});

/** The JSON-RPC rendering of a CircleAssetPolicy value. */
const policyJson = (overrides: Record<string, unknown> = {}) => ({
  type: `${PKG}::njangi_circles::CircleAssetPolicy`,
  fields: {
    settlement_asset: bytes(USDC_BYTES),
    assets: [
      {
        type: `${PKG}::njangi_circles::AssetTerms`,
        fields: {
          asset: bytes(USDC_BYTES),
          decimals: 6,
          contribution_amount: '10000000',
          security_deposit: '5000000',
        },
      },
    ],
    set_at_ms: '1790000000000',
    wallet_id: WALLET,
    legacy_ledger_entries: '3',
    ...overrides,
  },
});

const usdcPolicy = (): V11CircleAssetPolicy => {
  const parsed = parseCircleAssetPolicy(policyJson());
  if (!parsed) throw new Error('fixture did not parse');
  return parsed;
};

const targetsOf = (txb: Transaction): string[] =>
  txb.getData().commands.flatMap((command) =>
    'MoveCall' in command && command.MoveCall
      ? [`${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`]
      : [],
  );

describe('v11 pinned asset terms — reading', () => {
  it('parses the pinned terms, settlement asset and bound wallet', () => {
    const policy = usdcPolicy();
    expect(policy.settlement.coinType).toBe(USDC);
    expect(policy.settlement.decimals).toBe(6);
    expect(policy.settlement.contributionAmount).toBe(10_000_000n);
    expect(policy.settlement.securityDeposit).toBe(5_000_000n);
    expect(policy.walletId).toBe(WALLET);
    expect(policy.legacyLedgerEntries).toBe(3);
    expect(policy.setAtMs).toBe(1_790_000_000_000);
  });

  it('treats a partial or inconsistent policy as unreadable, never as "no terms"', () => {
    expect(parseCircleAssetPolicy(null)).toBeNull();
    expect(parseCircleAssetPolicy(policyJson({ wallet_id: undefined }))).toBeNull();
    expect(parseCircleAssetPolicy(policyJson({ settlement_asset: bytes(SUI_BYTES) }))).toBeNull();
  });

  it('reads the policy field off the circle by object read', async () => {
    const client = {
      getDynamicFields: jest.fn().mockResolvedValue({
        data: [
          { name: { type: 'vector<u8>', value: bytes('circle_config') }, objectId: ADDR('1') },
          { name: { type: `${PKG}::njangi_circles::AssetPolicyKey`, value: { dummy_field: false } }, objectId: ADDR('2') },
        ],
        hasNextPage: false,
        nextCursor: null,
      }),
      getObject: jest.fn().mockResolvedValue({
        data: { content: { dataType: 'moveObject', fields: { value: policyJson() } } },
      }),
    };
    const policy = await readCircleAssetPolicy(client as never, CIRCLE);
    expect(client.getObject).toHaveBeenCalledWith({ id: ADDR('2'), options: { showContent: true } });
    expect(policy?.settlement.coinType).toBe(USDC);
  });

  it('returns null for a circle without pinned terms and throws on an unreadable one', async () => {
    const empty = {
      getDynamicFields: jest.fn().mockResolvedValue({ data: [], hasNextPage: false, nextCursor: null }),
      getObject: jest.fn(),
    };
    await expect(readCircleAssetPolicy(empty as never, CIRCLE)).resolves.toBeNull();

    const broken = {
      getDynamicFields: jest.fn().mockResolvedValue({
        data: [{ name: { type: `${PKG}::njangi_circles::AssetPolicyKey`, value: {} }, objectId: ADDR('2') }],
        hasNextPage: false,
        nextCursor: null,
      }),
      getObject: jest.fn().mockResolvedValue({ data: { content: { fields: { value: { fields: {} } } } } }),
    };
    await expect(readCircleAssetPolicy(broken as never, CIRCLE)).rejects.toThrow('could not be read');
  });

  it('normalizes coin types', () => {
    expect(coinTypeFromTypeNameBytes(USDC_BYTES)).toBe(USDC);
    expect(isSuiCoinType('0x2::sui::SUI')).toBe(true);
    expect(isSuiCoinType(coinTypeFromTypeNameBytes(SUI_BYTES))).toBe(true);
    expect(isSuiCoinType(USDC)).toBe(false);
  });

  it('reads the registry id per network and refuses a malformed one', () => {
    const before = process.env.NEXT_PUBLIC_TESTNET_NJANGI_ASSET_REGISTRY_ID;
    process.env.NEXT_PUBLIC_TESTNET_NJANGI_ASSET_REGISTRY_ID = REGISTRY;
    expect(getAssetRegistryId('testnet')).toBe(REGISTRY);
    process.env.NEXT_PUBLIC_TESTNET_NJANGI_ASSET_REGISTRY_ID = '0xyour_testnet_asset_registry_id';
    expect(getAssetRegistryId('testnet')).toBeNull();
    process.env.NEXT_PUBLIC_TESTNET_NJANGI_ASSET_REGISTRY_ID = before;
  });
});

describe('v11 create', () => {
  it('pins USDC amounts at the peg and SUI amounts as computed', () => {
    expect(
      nativeTermsForCreate({
        settlement: 'USDC',
        contributionUsdCents: 1000n,
        depositUsdCents: 500n,
        suiContributionMist: 9n,
        suiDepositMist: 9n,
      }),
    ).toEqual({ contributionNative: 10_000_000n, depositNative: 5_000_000n });
    expect(
      nativeTermsForCreate({
        settlement: 'SUI',
        contributionUsdCents: 1000n,
        depositUsdCents: 500n,
        suiContributionMist: 2_000_000_000n,
        suiDepositMist: 1_000_000_000n,
      }),
    ).toEqual({ contributionNative: 2_000_000_000n, depositNative: 1_000_000_000n });
  });

  it('builds create_circle_with_asset<T> with the registry and native terms', () => {
    const tx = buildCreateCircleWithAssetTx({
      packageId: PKG,
      registryId: REGISTRY,
      coinType: USDC,
      circleData: circleData(),
      contributionNative: 10_000_000n,
      depositNative: 5_000_000n,
    });
    const call = tx.getData().commands[0].MoveCall!;
    expect(`${call.package}::${call.module}::${call.function}`).toBe(
      `${PKG}::njangi_circles::create_circle_with_asset`,
    );
    expect(call.typeArguments).toEqual([USDC]);
    expect(call.arguments).toHaveLength(24);
  });

  it('refuses a deposit under half a contribution before signing', () => {
    expect(() =>
      buildCreateCircleWithAssetTx({
        packageId: PKG,
        registryId: REGISTRY,
        coinType: USDC,
        circleData: circleData(),
        contributionNative: 10_000_000n,
        depositNative: 4_999_999n,
      }),
    ).toThrow('at least half a contribution');
  });

  it('accepts the half of an odd share the contract accepts, rounded down', () => {
    // njangi_core::min_security_deposit is `contribution / 2` in integer
    // math. A SUI share priced at today's rate is often an odd number of
    // MIST (production 2026-10-06: $0.10 → 84_745_763), and its default
    // half deposit rounds to 42_372_881, which the contract takes.
    const SUI = '0x2::sui::SUI';
    const build = (depositNative: bigint) =>
      buildCreateCircleWithAssetTx({
        packageId: PKG,
        registryId: REGISTRY,
        coinType: SUI,
        circleData: circleData(),
        contributionNative: 84_745_763n,
        depositNative,
      });
    expect(() => build(42_372_881n)).not.toThrow();
    expect(() => build(42_372_880n)).toThrow('at least half a contribution');
  });
});

describe('v11 security deposit', () => {
  const coinsClient = (balances: string[]) => ({
    getCoins: jest.fn().mockResolvedValue({
      data: balances.map((balance, i) => ({ coinObjectId: ADDR(String(i + 1)), balance })),
      hasNextPage: false,
      nextCursor: null,
    }),
  });

  it('posts exactly the pinned deposit in the pinned coin from the member\'s own coins', async () => {
    const txb = new Transaction();
    const client = coinsClient(['3000000', '4000000']);
    const result = await buildPostSecurityDepositTx(txb, client as never, {
      packageId: PKG,
      registryId: REGISTRY,
      circleId: CIRCLE,
      userAddress: MEMBER,
      policy: usdcPolicy(),
    });
    expect(result).toEqual({ coinType: USDC, amount: 5_000_000n, usesGasCoinForValue: false });
    const commands = txb.getData().commands;
    expect(commands.map((c) => c.$kind)).toEqual(['MergeCoins', 'SplitCoins', 'MoveCall']);
    expect(commands[2].MoveCall!.typeArguments).toEqual([USDC]);
    expect(targetsOf(txb)).toEqual([`${PKG}::njangi_circles::post_security_deposit`]);
    // The bound wallet comes from the circle's terms, not from the caller.
    const objects = txb.getData().inputs.filter((input) => input.UnresolvedObject).map((input) => input.UnresolvedObject!.objectId);
    expect(objects).toContain(WALLET);
    expect(objects).toContain(REGISTRY);
  });

  it('refuses before signing when the member lacks the coin', async () => {
    await expect(
      buildPostSecurityDepositTx(new Transaction(), coinsClient(['1']) as never, {
        packageId: PKG,
        registryId: REGISTRY,
        circleId: CIRCLE,
        userAddress: MEMBER,
        policy: usdcPolicy(),
      }),
    ).rejects.toBeInstanceOf(InsufficientCoinBalanceError);
  });

  it('a SUI deposit splits from gas and reports it, so it is never sponsored', async () => {
    const policy = parseCircleAssetPolicy(
      policyJson({
        settlement_asset: bytes(SUI_BYTES),
        assets: [
          {
            fields: {
              asset: bytes(SUI_BYTES),
              decimals: 9,
              contribution_amount: '2000000000',
              security_deposit: '1000000000',
            },
          },
        ],
      }),
    )!;
    const txb = new Transaction();
    const result = await buildPostSecurityDepositTx(txb, coinsClient([]) as never, {
      packageId: PKG,
      registryId: REGISTRY,
      circleId: CIRCLE,
      userAddress: MEMBER,
      policy,
    });
    expect(result.usesGasCoinForValue).toBe(true);
    expect(txb.getData().commands.map((c) => c.$kind)).toEqual(['SplitCoins', 'MoveCall']);
  });

  it('the deposit transaction stays inside the sponsorship allowlist', async () => {
    const txb = new Transaction();
    await buildPostSecurityDepositTx(txb, coinsClient(['5000000']) as never, {
      packageId: PKG,
      registryId: REGISTRY,
      circleId: CIRCLE,
      userAddress: MEMBER,
      policy: usdcPolicy(),
    });
    const allowed = new Set(allowedMoveCallTargets(PKG));
    expect(targetsOf(txb).filter((target) => !allowed.has(target))).toEqual([]);
  });
});

describe('v11 refunds, removal, conversion and rounds', () => {
  const base = { packageId: PKG, circleId: CIRCLE, walletId: WALLET, coinType: USDC };

  it.each([
    ['refund_asset', buildRefundAssetTx(base)],
    ['claim_own_refund', buildClaimOwnRefundTx(base)],
    ['admin_remove_member_asset', buildAdminRemoveMemberAssetTx({ ...base, memberAddress: MEMBER })],
    ['adopt_asset_policy', buildAdoptAssetPolicyTx({ ...base, registryId: REGISTRY })],
  ])('%s targets njangi_circles with the coin type', (fn, tx) => {
    const call = tx.getData().commands[0].MoveCall!;
    expect(`${call.module}::${call.function}`).toBe(`njangi_circles::${fn}`);
    expect(call.typeArguments).toEqual([USDC]);
  });

  it('refunds, the claim and the deposit-returning removal are sponsorable; conversion is not', () => {
    const allowed = new Set(allowedMoveCallTargets(PKG));
    expect(allowed.has(`${PKG}::njangi_circles::refund_asset`)).toBe(true);
    expect(allowed.has(`${PKG}::njangi_circles::claim_own_refund`)).toBe(true);
    // The admin's "Return Deposit & Remove Member": it pays only the removed
    // member's own recorded deposit back to them (recovery-sponsorship.ts).
    expect(allowed.has(`${PKG}::njangi_circles::admin_remove_member_asset`)).toBe(true);
    expect(allowed.has(`${PKG}::njangi_circles::adopt_asset_policy`)).toBe(false);
  });

  it('the planned close chains complete_circle with the deposit refund, inside the allowlist', () => {
    const tx = buildCompleteCircleTx(base);
    const calls = tx.getData().commands.map((c) => c.MoveCall!);
    expect(calls.map((c) => `${c.module}::${c.function}`)).toEqual([
      'njangi_circles::complete_circle',
      'njangi_circles::refund_asset',
    ]);
    expect(calls[0].typeArguments).toEqual([]);
    expect(calls[1].typeArguments).toEqual([USDC]);
    const allowed = new Set(allowedMoveCallTargets(PKG));
    expect(targetsOf(tx).filter((target) => !allowed.has(target))).toEqual([]);
  });

  it('refuses the planned close without a coin type (nothing to refund in)', () => {
    expect(() => buildCompleteCircleTx({ ...base, coinType: '' })).toThrow();
  });

  describe('readCircleCompletion', () => {
    const completionField = {
      name: { type: `${PKG}::njangi_circles::CompletionKey`, value: {} },
      objectId: ADDR('3'),
    };

    it('reads the close record the organizer left', async () => {
      const client = {
        getDynamicFields: jest.fn().mockResolvedValue({
          data: [completionField],
          hasNextPage: false,
          nextCursor: null,
        }),
        getObject: jest.fn().mockResolvedValue({
          data: {
            content: {
              fields: {
                value: { fields: { completed_at_ms: '1700000000000', cycle_no: '3', completed_by: MEMBER } },
              },
            },
          },
        }),
      };
      await expect(readCircleCompletion(client as never, CIRCLE)).resolves.toEqual({
        completedAtMs: 1700000000000,
        cycleNo: 3,
        completedBy: MEMBER,
      });
      expect(client.getObject).toHaveBeenCalledWith({ id: ADDR('3'), options: { showContent: true } });
    });

    it('answers null for a circle with no record, and throws on one it cannot read', async () => {
      const none = {
        getDynamicFields: jest.fn().mockResolvedValue({ data: [], hasNextPage: false, nextCursor: null }),
        getObject: jest.fn(),
      };
      await expect(readCircleCompletion(none as never, CIRCLE)).resolves.toBeNull();
      expect(none.getObject).not.toHaveBeenCalled();

      const broken = {
        getDynamicFields: jest.fn().mockResolvedValue({ data: [completionField], hasNextPage: false, nextCursor: null }),
        getObject: jest.fn().mockResolvedValue({ data: { content: { fields: { value: { fields: {} } } } } }),
      };
      await expect(readCircleCompletion(broken as never, CIRCLE)).rejects.toThrow('could not be read');
    });
  });

  it('builds the pinned-terms round open and the invalid-round release', () => {
    const open = buildOpenRoundTx({ packageId: PKG, circleId: CIRCLE, registryId: REGISTRY, coinType: USDC });
    expect(targetsOf(open)).toEqual([`${PKG}::njangi_cycle_escrow::open_round`]);
    const release = buildReleaseInvalidRoundTx({ packageId: PKG, circleId: CIRCLE, escrowId: ADDR('f'), coinType: USDC });
    expect(targetsOf(release)).toEqual([`${PKG}::njangi_cycle_escrow::release_invalid_round`]);
  });

  it('rejects a malformed coin type', () => {
    expect(() => buildRefundAssetTx({ ...base, coinType: 'usdc' })).toThrow('Coin type is invalid.');
  });
});
