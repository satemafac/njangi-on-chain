// walrus-epoch.test.ts — The renewal cron's epoch source. Walrus storage
// leases end at WALRUS epochs; the cron used to compare them with the Sui
// epoch (testnet 2026-10-02: Walrus 538, Sui 1240) and re-stored every blob
// on every run. These tests pin where the Walrus epoch is read from (the
// System object's versioned inner state, committee.epoch) and that every
// failed or odd read throws instead of producing a number.

import type { SuiObjectResponse } from '@mysten/sui/client';
import {
  DEFAULT_WALRUS_SYSTEM_OBJECT_IDS,
  WALRUS_SYSTEM_OBJECT_ID_ENV,
  readCurrentWalrusEpoch,
  readWalrusEpoch,
  resolveWalrusSystemObjectId,
  type WalrusEpochClient,
} from '../walrus-epoch';

const TESTNET_SYSTEM = DEFAULT_WALRUS_SYSTEM_OBJECT_IDS.testnet;
const WALRUS_PKG = '0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66';
const OVERRIDE_ID = `0x${'ab'.repeat(32)}`;

// Shaped like publicnode's sui_getObject answer for the testnet System
// object on 2026-10-02 (showContent).
function systemObject(
  overrides: { type?: string; fields?: Record<string, unknown> } = {},
): SuiObjectResponse {
  const type = overrides.type ?? `${WALRUS_PKG}::system::System`;
  return {
    data: {
      objectId: TESTNET_SYSTEM,
      version: '1038223032',
      digest: '33sBJLxas9nkMiB8eM4xuYboxuXDJpDQMD7HGxpsEqrw',
      content: {
        dataType: 'moveObject',
        type,
        hasPublicTransfer: false,
        fields: overrides.fields ?? {
          id: { id: TESTNET_SYSTEM },
          new_package_id: null,
          package_id: '0x849e95d2718938d66c37fb91df76d72f78526c1864c339bac415ce8ecda2d8cc',
          version: '3',
        },
      },
    },
  } as unknown as SuiObjectResponse;
}

// Shaped like suix_getDynamicFieldObject for name { type: 'u64', value: '3' }.
function systemState(
  overrides: { epoch?: unknown; innerType?: string; value?: unknown } = {},
): SuiObjectResponse {
  const innerType = overrides.innerType ?? `${WALRUS_PKG}::system_state_inner::SystemStateInnerV1`;
  const value =
    'value' in overrides
      ? overrides.value
      : {
          type: innerType,
          fields: {
            committee: {
              type: `${WALRUS_PKG}::bls_aggregate::BlsCommittee`,
              fields: {
                epoch: 'epoch' in overrides ? overrides.epoch : 538,
                members: [],
                n_shards: 1000,
              },
            },
            storage_price_per_unit_size: '3028',
            write_price_per_unit_size: '6041',
          },
        };
  return {
    data: {
      objectId: '0x7fb94d17d38b895b1aaa25319343970b04b3cebfba7940ceddff8dfcedade095',
      version: '1038223032',
      digest: 'digest',
      content: {
        dataType: 'moveObject',
        type: `0x2::dynamic_field::Field<u64, ${innerType}>`,
        hasPublicTransfer: false,
        fields: { id: { id: '0x7fb9' }, name: '3', value },
      },
    },
  } as unknown as SuiObjectResponse;
}

function notFound(code: string): SuiObjectResponse {
  return { error: { code } } as unknown as SuiObjectResponse;
}

function fakeClient(
  responses: {
    system?: SuiObjectResponse | Error;
    state?: SuiObjectResponse | Error;
  } = {},
) {
  const answer = (value: SuiObjectResponse | Error | undefined, fallback: () => SuiObjectResponse) =>
    jest.fn(async () => {
      if (value instanceof Error) throw value;
      return value ?? fallback();
    });
  const getObject = answer(responses.system, () => systemObject());
  const getDynamicFieldObject = answer(responses.state, () => systemState());
  const client = { getObject, getDynamicFieldObject } as unknown as WalrusEpochClient;
  return { client, getObject, getDynamicFieldObject };
}

describe('resolveWalrusSystemObjectId', () => {
  it('defaults to the System objects in the Walrus network reference', () => {
    expect(resolveWalrusSystemObjectId('testnet', {})).toBe(
      '0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af',
    );
    expect(resolveWalrusSystemObjectId('mainnet', {})).toBe(
      '0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2',
    );
  });

  it('applies an override to its own network only', () => {
    const env = { WALRUS_SYSTEM_OBJECT_ID_TESTNET: OVERRIDE_ID };
    expect(resolveWalrusSystemObjectId('testnet', env)).toBe(OVERRIDE_ID);
    expect(resolveWalrusSystemObjectId('mainnet', env)).toBe(DEFAULT_WALRUS_SYSTEM_OBJECT_IDS.mainnet);
  });

  it('trims and normalizes an override', () => {
    const env = { WALRUS_SYSTEM_OBJECT_ID_MAINNET: `  ${OVERRIDE_ID.toUpperCase().replace('0X', '0x')}  ` };
    expect(resolveWalrusSystemObjectId('mainnet', env)).toBe(OVERRIDE_ID);
  });

  it('treats an empty override as unset', () => {
    expect(resolveWalrusSystemObjectId('testnet', { WALRUS_SYSTEM_OBJECT_ID_TESTNET: '  ' })).toBe(
      TESTNET_SYSTEM,
    );
  });

  it.each(['not-an-id', '0x0', `0x${'g'.repeat(64)}`, `0x${'a'.repeat(65)}`])(
    'throws on a malformed override (%s) instead of falling back',
    (value) => {
      expect(() =>
        resolveWalrusSystemObjectId('testnet', { WALRUS_SYSTEM_OBJECT_ID_TESTNET: value }),
      ).toThrow(/WALRUS_SYSTEM_OBJECT_ID_TESTNET is not a Sui object id/);
    },
  );

  it('names one override variable per network', () => {
    expect(WALRUS_SYSTEM_OBJECT_ID_ENV).toEqual({
      testnet: 'WALRUS_SYSTEM_OBJECT_ID_TESTNET',
      mainnet: 'WALRUS_SYSTEM_OBJECT_ID_MAINNET',
    });
  });
});

describe('readWalrusEpoch', () => {
  it("reads committee.epoch from the inner state keyed by the System object's version", async () => {
    const { client, getObject, getDynamicFieldObject } = fakeClient();

    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).resolves.toBe(538);

    expect(getObject).toHaveBeenCalledWith({ id: TESTNET_SYSTEM, options: { showContent: true } });
    expect(getDynamicFieldObject).toHaveBeenCalledWith({
      parentId: TESTNET_SYSTEM,
      name: { type: 'u64', value: '3' },
    });
  });

  it('accepts an epoch rendered as a decimal string', async () => {
    const { client } = fakeClient({ state: systemState({ epoch: '41' }) });
    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).resolves.toBe(41);
  });

  it('accepts a later SystemStateInner version', async () => {
    const { client } = fakeClient({
      state: systemState({ innerType: `${WALRUS_PKG}::system_state_inner::SystemStateInnerV2` }),
    });
    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).resolves.toBe(538);
  });

  it('throws when the System object cannot be read', async () => {
    const { client, getDynamicFieldObject } = fakeClient({ system: notFound('notExists') });
    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).rejects.toThrow(
      `Walrus System object ${TESTNET_SYSTEM} could not be read (notExists).`,
    );
    expect(getDynamicFieldObject).not.toHaveBeenCalled();
  });

  it('throws when the object is not a Walrus System object (e.g. the staking object)', async () => {
    const { client, getDynamicFieldObject } = fakeClient({
      system: systemObject({ type: `${WALRUS_PKG}::staking::Staking` }),
    });
    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).rejects.toThrow(
      /is a 0x[0-9a-f]+::staking::Staking, not a Walrus ::system::System object/,
    );
    expect(getDynamicFieldObject).not.toHaveBeenCalled();
  });

  it('throws when the System object has no usable version', async () => {
    const { client } = fakeClient({
      system: systemObject({ fields: { id: { id: TESTNET_SYSTEM }, version: 'three' } }),
    });
    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).rejects.toThrow(/no whole-number version/);
  });

  it('throws when the versioned inner state is missing', async () => {
    const { client } = fakeClient({ state: notFound('dynamicFieldNotFound') });
    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).rejects.toThrow(
      /system state v3 .* could not be read \(dynamicFieldNotFound\)/,
    );
  });

  it('throws when the inner state is not a SystemStateInner', async () => {
    const { client } = fakeClient({
      state: systemState({ innerType: `${WALRUS_PKG}::staking_inner::StakingInnerV1` }),
    });
    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).rejects.toThrow(/is not a SystemStateInner/);
  });

  it('throws when the response carries no Move object content', async () => {
    const { client } = fakeClient({ system: { data: { objectId: TESTNET_SYSTEM } } as SuiObjectResponse });
    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).rejects.toThrow(/without Move object content/);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['negative', -1],
    ['fractional', 538.5],
    ['non-numeric', 'epoch-538'],
    ['unsafe', 2 ** 53],
    ['an object', { value: 538 }],
  ])('throws when committee.epoch is %s', async (_label, epoch) => {
    const { client } = fakeClient({ state: systemState({ epoch }) });
    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).rejects.toThrow(
      /no whole-number committee\.epoch/,
    );
  });

  it('propagates a failed RPC call', async () => {
    const { client } = fakeClient({ state: new Error('fetch failed') });
    await expect(readWalrusEpoch(client, TESTNET_SYSTEM)).rejects.toThrow('fetch failed');
  });
});

describe('readCurrentWalrusEpoch', () => {
  it("reads the active network's documented System object by default", async () => {
    const { client, getObject } = fakeClient();
    await expect(readCurrentWalrusEpoch(client, 'mainnet', {})).resolves.toBe(538);
    expect(getObject).toHaveBeenCalledWith(
      expect.objectContaining({ id: DEFAULT_WALRUS_SYSTEM_OBJECT_IDS.mainnet }),
    );
  });

  it('reads the override when one is set', async () => {
    const { client, getObject } = fakeClient();
    await readCurrentWalrusEpoch(client, 'testnet', { WALRUS_SYSTEM_OBJECT_ID_TESTNET: OVERRIDE_ID });
    expect(getObject).toHaveBeenCalledWith(expect.objectContaining({ id: OVERRIDE_ID }));
  });

  it('names the network, the object and its override variable when the read fails', async () => {
    const { client } = fakeClient({ system: new Error('fetch failed') });
    await expect(readCurrentWalrusEpoch(client, 'testnet', {})).rejects.toThrow(
      `Could not read the current Walrus epoch on testnet from System object ${TESTNET_SYSTEM} ` +
        '(override: WALRUS_SYSTEM_OBJECT_ID_TESTNET): fetch failed',
    );
  });

  it('throws on a malformed override before any RPC call', async () => {
    const { client, getObject } = fakeClient();
    await expect(
      readCurrentWalrusEpoch(client, 'testnet', { WALRUS_SYSTEM_OBJECT_ID_TESTNET: 'oops' }),
    ).rejects.toThrow(/WALRUS_SYSTEM_OBJECT_ID_TESTNET is not a Sui object id/);
    expect(getObject).not.toHaveBeenCalled();
  });
});
