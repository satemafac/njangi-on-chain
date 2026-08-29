// GET /api/circle-stats — how many circles exist on the active network.
//
// Published on the public landing page as a claim about real usage, which
// sets two rules:
//
//  1. NEVER invent the number. This endpoint used to fall back to a
//     hardcoded 3 ("reasonable fallback for demo") on any failure and
//     return it with success:true — a fabricated statistic on a marketing
//     page. `null` means "unknown", and index.tsx already renders a
//     syncing state for it.
//  2. Route through the failover chain. Counting every circle needs an
//     event scan (there is no global object index), and event history is
//     the least reliable primitive here: publicnode/suiscan serve object
//     reads but REFUSE event history, while the endpoint that can serve it
//     is rationed. The hand-rolled two-URL list this file used to carry put
//     the refusing endpoint first and never recovered, so once the invented
//     fallback was removed the count read as unknown forever.
//
// Cached, because this is a public page: an uncached scan would spend a
// rationed event budget on every visitor.

import { NextApiRequest, NextApiResponse } from 'next';
import { getCurrentNetwork } from '@/services/network-config';
import { getPublishedPackageMetadata } from '@/lib/circle-chain';
import { withSuiRpcFailover } from '@/services/sui-rpc-failover';

type ResponseData = {
  success: boolean;
  data?: {
    /** null = could not read; the landing page renders a syncing state. */
    circleCount: number | null;
  };
  message?: string;
};

const CACHE_TTL_MS = 5 * 60_000;
const MAX_PAGES = 10;

let cached: { value: number; atMs: number } | null = null;

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<ResponseData>,
) {
  if (cached && Date.now() - cached.atMs < CACHE_TTL_MS) {
    return res.status(200).json({ success: true, data: { circleCount: cached.value } });
  }

  const network = getCurrentNetwork();
  // Move event types anchor to the package that DEFINED them, so the
  // original id is the only filter that matches after an upgrade.
  const { originalId } = getPublishedPackageMetadata(network);
  if (!originalId) {
    return res.status(200).json({ success: true, data: { circleCount: null } });
  }

  try {
    const total = await withSuiRpcFailover(network, 'circle-stats', async (client) => {
      let count = 0;
      let cursor: { txDigest: string; eventSeq: string } | null | undefined = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const events = await client.queryEvents({
          query: { MoveEventType: `${originalId}::njangi_circles::CircleCreated` },
          cursor: cursor ?? undefined,
          limit: 50,
          order: 'descending',
        });
        count += events.data.length;
        if (!events.hasNextPage || !events.nextCursor) break;
        cursor = events.nextCursor;
      }
      return count;
    });

    cached = { value: total, atMs: Date.now() };
    return res.status(200).json({ success: true, data: { circleCount: total } });
  } catch (error) {
    // Every endpoint failed or refused. Serve a stale-but-real number if we
    // have one; otherwise say unknown. Never a made-up figure.
    console.error('[circle-stats] event scan failed on every RPC', error);
    return res.status(200).json({
      success: true,
      data: { circleCount: cached?.value ?? null },
    });
  }
}
