// invite-preview.ts — what a shared invite link says about itself.
//
// `/circle/<id>/join` is the most-shared URL in the product: it goes out over
// WhatsApp and iMessage, and those clients render a link card from the
// server-rendered <meta> tags. Until 2026-09 the join page emitted its share
// tags only after the client had loaded the circle, so every crawler saw the
// site defaults and the card read "Rotating Savings Circles for the Diaspora"
// instead of an invitation. This module gives the page a server-side read of
// the few facts a card needs, and one place that turns them into copy, so
// the SSR tags, the client-side tags and the tests all agree.

import { SuiClient } from '@mysten/sui/client';
import { getCircleConfigFields } from './circle-config';
import { getNetworkConfig, type NetworkType } from '../services/network-config';

export interface InvitePreview {
  name: string;
  currentMembers: number | null;
  maxMembers: number | null;
  /** USD amount per contribution, from the on-chain local amount (cents). */
  contributionUsd: number | null;
  /** 0 weekly, 1 monthly, 2 quarterly, 3 bi-weekly — the contract's encoding. */
  cycleLength: number | null;
}

export interface InviteShareCopy {
  title: string;
  description: string;
}

const READ_TIMEOUT_MS = 4_000;
const OBJECT_ID = /^0x[0-9a-f]{64}$/;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Bare object id or null; the page must not pass user input straight to RPC. */
export function normalizeCircleIdParam(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return OBJECT_ID.test(withPrefix) ? withPrefix : null;
}

export function describeCadence(cycleLength: number | null): string | null {
  switch (cycleLength) {
    case 0:
      return 'every week';
    case 1:
      return 'every month';
    case 2:
      return 'every quarter';
    case 3:
      return 'every two weeks';
    default:
      return null;
  }
}

function formatUsd(amount: number): string {
  return amount % 1 === 0 ? `$${amount.toFixed(0)}` : `$${amount.toFixed(2)}`;
}

/**
 * The card copy. Works with a partial preview (name only) and with none at
 * all, so a failed server read still produces an invitation rather than the
 * marketing card.
 */
export function buildInviteShareCopy(preview: InvitePreview | null): InviteShareCopy {
  const name = preview?.name?.trim();
  if (!name) {
    return {
      title: "You've been invited to join a savings circle on Njangi On-Chain",
      description:
        'A friend is inviting you into their njangi. Open the link to see the terms and request your seat — no seed phrase needed.',
    };
  }

  const parts: string[] = [];
  const cadence = describeCadence(preview?.cycleLength ?? null);
  if (preview?.contributionUsd !== null && preview?.contributionUsd !== undefined && preview.contributionUsd > 0) {
    parts.push(`${formatUsd(preview.contributionUsd)} ${cadence ?? 'per round'}`);
  } else if (cadence) {
    parts.push(`contributions ${cadence}`);
  }
  if (preview?.maxMembers && preview.maxMembers > 0) {
    const current = preview.currentMembers ?? 0;
    parts.push(`${current} of ${preview.maxMembers} seats taken`);
  }
  const terms = parts.length > 0 ? ` ${parts.join(' · ')}.` : '';

  return {
    title: `You've been invited to join ${name} on Njangi On-Chain`,
    description: `${name} is a savings circle where members pay in and take turns receiving the pot.${terms} Open the link to request your seat — no seed phrase needed.`,
  };
}

type PreviewClient = Pick<SuiClient, 'getObject' | 'getDynamicFields'>;

/**
 * Server-side read of the facts a share card needs. Bounded by a short
 * timeout (crawlers give up fast) and never throws: any failure returns
 * null and the page falls back to the generic invitation copy.
 */
export async function readInvitePreview(
  circleId: string,
  network: NetworkType,
  client?: PreviewClient,
): Promise<InvitePreview | null> {
  const rpc: PreviewClient = client ?? new SuiClient({ url: getNetworkConfig(network).rpcUrl });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_TIMEOUT_MS));

  const read = (async (): Promise<InvitePreview | null> => {
    const obj = await rpc.getObject({ id: circleId, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') return null;
    const fields = (content as { fields: Record<string, unknown> }).fields;
    const name = typeof fields.name === 'string' ? fields.name : '';
    if (!name) return null;

    let contributionUsd: number | null = null;
    let cycleLength: number | null = null;
    let maxMembers: number | null = null;
    try {
      const config = await getCircleConfigFields(rpc, circleId);
      if (config) {
        const cents = num(config.contribution_amount_local);
        contributionUsd = cents === null ? null : cents / 100;
        cycleLength = num(config.cycle_length);
        maxMembers = num(config.max_members);
      }
    } catch {
      // Terms are a nicety; the name alone still makes an invitation.
    }

    return {
      name,
      currentMembers: num(fields.current_members),
      maxMembers,
      contributionUsd,
      cycleLength,
    };
  })().catch(() => null);

  return Promise.race([read, timeout]);
}
