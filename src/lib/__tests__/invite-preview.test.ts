/**
 * Share-card copy for invite links. The join page emits these tags on the
 * server so WhatsApp/iMessage cards read as an invitation; this pins the
 * copy and the reader's never-throw, bounded contract.
 */

jest.mock('../../services/network-config', () => ({
  getNetworkConfig: () => ({ rpcUrl: 'https://rpc.invalid' }),
}));

import {
  buildInviteShareCopy,
  describeCadence,
  normalizeCircleIdParam,
  readInvitePreview,
} from '../invite-preview';

const CIRCLE = '0x' + 'ab'.repeat(32);

describe('buildInviteShareCopy', () => {
  it('names the circle and states the terms when they are known', () => {
    const copy = buildInviteShareCopy({
      name: 'Family Reunion 2026',
      currentMembers: 1,
      maxMembers: 3,
      contributionUsd: 0.1,
      cycleLength: 1,
    });
    expect(copy.title).toBe("You've been invited to join Family Reunion 2026 on Njangi On-Chain");
    expect(copy.description).toContain('$0.10 every month');
    expect(copy.description).toContain('1 of 3 seats taken');
    expect(copy.description).toMatch(/request your seat/);
  });

  it('still invites by name when the terms could not be read', () => {
    const copy = buildInviteShareCopy({
      name: 'Cadena',
      currentMembers: null,
      maxMembers: null,
      contributionUsd: null,
      cycleLength: null,
    });
    expect(copy.title).toContain('join Cadena');
    expect(copy.description).not.toContain('seats taken');
    expect(copy.description).not.toContain('undefined');
  });

  it('falls back to a generic invitation, never the marketing card, with no preview', () => {
    const copy = buildInviteShareCopy(null);
    expect(copy.title).toMatch(/^You've been invited to join a savings circle/);
    expect(copy.title).not.toMatch(/Diaspora/);
  });

  it('formats whole-dollar amounts without cents', () => {
    const copy = buildInviteShareCopy({ name: 'X', currentMembers: 0, maxMembers: 5, contributionUsd: 25, cycleLength: 0 });
    expect(copy.description).toContain('$25 every week');
  });
});

describe('describeCadence / normalizeCircleIdParam', () => {
  it('maps the contract encoding and rejects unknowns', () => {
    expect(describeCadence(0)).toBe('every week');
    expect(describeCadence(3)).toBe('every two weeks');
    expect(describeCadence(7)).toBeNull();
  });

  it('accepts a 32-byte hex id with or without 0x and rejects anything else', () => {
    expect(normalizeCircleIdParam(CIRCLE)).toBe(CIRCLE);
    expect(normalizeCircleIdParam(CIRCLE.slice(2).toUpperCase())).toBe(CIRCLE);
    expect(normalizeCircleIdParam('0x123')).toBeNull();
    expect(normalizeCircleIdParam(['a'])).toBeNull();
    expect(normalizeCircleIdParam(undefined)).toBeNull();
  });
});

describe('readInvitePreview', () => {
  const client = (fields: Record<string, unknown> | null, config?: Record<string, unknown>) =>
    ({
      getObject: jest.fn(async ({ id }: { id: string }) => {
        if (id === CIRCLE) {
          return fields
            ? { data: { content: { dataType: 'moveObject', fields } } }
            : { data: { content: { dataType: 'package' } } };
        }
        // the CircleConfig object
        return { data: { content: { dataType: 'moveObject', type: 'x::njangi_circle_config::CircleConfig', fields: config ?? {} } } };
      }),
      getDynamicFields: jest.fn(async () => ({
        data: config
          ? [{ objectId: '0x' + 'cc'.repeat(32), objectType: '0x1::dynamic_field::Field<vector<u8>, 0x2::njangi_circle_config::CircleConfig>', name: { type: 'vector<u8>', value: [99, 105, 114, 99, 108, 101, 95, 99, 111, 110, 102, 105, 103] } }]
          : [],
      })),
    }) as never;

  it('reads the name, member count and terms', async () => {
    const preview = await readInvitePreview(CIRCLE, 'testnet', client(
      { name: 'Family Reunion 2026', current_members: '1' },
      { contribution_amount_local: '10', cycle_length: '1', max_members: '3' },
    ));
    expect(preview).toEqual({
      name: 'Family Reunion 2026',
      currentMembers: 1,
      maxMembers: 3,
      contributionUsd: 0.1,
      cycleLength: 1,
    });
  });

  it('returns the name alone when the config cannot be read', async () => {
    const preview = await readInvitePreview(CIRCLE, 'testnet', client({ name: 'Cadena', current_members: '2' }));
    expect(preview?.name).toBe('Cadena');
    expect(preview?.contributionUsd).toBeNull();
  });

  it('returns null for a non-circle object and never throws on RPC failure', async () => {
    await expect(readInvitePreview(CIRCLE, 'testnet', client(null))).resolves.toBeNull();
    const failing = { getObject: jest.fn().mockRejectedValue(new Error('429')), getDynamicFields: jest.fn() } as never;
    await expect(readInvitePreview(CIRCLE, 'testnet', failing)).resolves.toBeNull();
  });
});
