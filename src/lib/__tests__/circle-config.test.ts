// No Sui GraphQL URL in these cases: they read with the mocked getObject
// only and never reach the network. The GraphQL step is covered in
// src/__tests__/lib/circle-config-graphql*.test.ts.
jest.mock('@/services/network-config', () => ({
  getCurrentNetwork: () => 'testnet',
  getGraphqlUrlForNetwork: () => '',
}));

import {
  extractCircleConfigFieldsFromObjectContent,
  getCircleConfigFields,
  getCircleConfigFieldsByObjectId,
  getCircleConfigObjectId,
  isCircleConfigDynamicField,
} from '@/lib/circle-config';

describe('circle-config helpers', () => {
  it('detects CircleConfig dynamic fields across supported shapes', () => {
    expect(
      isCircleConfigDynamicField({
        objectType: '0x1::njangi_circle_config::CircleConfig',
      }),
    ).toBe(true);

    expect(
      isCircleConfigDynamicField({
        type: '0x1::njangi_circle_config::CircleConfig',
      }),
    ).toBe(true);

    expect(
      isCircleConfigDynamicField({
        name: { type: '0x1::njangi_circle_config::CircleConfig' },
      }),
    ).toBe(true);

    expect(
      isCircleConfigDynamicField({
        name: { value: 'circle_config' },
      }),
    ).toBe(true);

    expect(
      isCircleConfigDynamicField({
        objectType: '0x1::something_else::OtherField',
      }),
    ).toBe(false);
  });

  it('returns the first CircleConfig object id from dynamic fields', () => {
    expect(
      getCircleConfigObjectId([
        { objectId: '0xnope', objectType: '0x1::other::Thing' },
        { objectId: '0xconfig', objectType: '0x1::njangi_circle_config::CircleConfig' },
      ]),
    ).toBe('0xconfig');
  });

  it('extracts merged CircleConfig fields from root and nested content', () => {
    expect(
      extractCircleConfigFieldsFromObjectContent({
        fields: {
          contribution_amount: '100',
          value: {
            fields: {
              contribution_amount: '200',
              max_members: '12',
            },
          },
        },
      }),
    ).toEqual({
      contribution_amount: '200',
      max_members: '12',
      value: {
        fields: {
          contribution_amount: '200',
          max_members: '12',
        },
      },
    });
  });

  it('loads config fields by object id', async () => {
    const client = {
      getObject: jest.fn().mockResolvedValue({
        data: {
          content: {
            fields: {
              value: {
                fields: {
                  contribution_amount_usd: '2500',
                },
              },
            },
          },
        },
      }),
    };

    await expect(
      getCircleConfigFieldsByObjectId(client as never, '0xconfig'),
    ).resolves.toEqual({
      contribution_amount_usd: '2500',
      value: {
        fields: {
          contribution_amount_usd: '2500',
        },
      },
    });
  });

  it('loads config fields from a circle id', async () => {
    const client = {
      // A complete JSON-RPC page, as the endpoint returns it: getCircleConfigFields reads every page and refuses a
      // page that does not say whether more follow (it could be partial).
      getDynamicFields: jest.fn().mockResolvedValue({
        data: [{ objectId: '0xconfig', objectType: '0x1::njangi_circle_config::CircleConfig' }],
        hasNextPage: false,
        nextCursor: null,
      }),
      getObject: jest.fn().mockResolvedValue({
        data: {
          content: {
            fields: {
              security_deposit_usd: '900',
            },
          },
        },
      }),
    };

    await expect(
      getCircleConfigFields(client as never, '0xcircle'),
    ).resolves.toEqual({
      security_deposit_usd: '900',
    });
  });
});
