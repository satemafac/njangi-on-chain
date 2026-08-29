import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import joinRequestDatabase from '../../../services/join-request-database';
import databaseService from '../../../services/database-service';
import { resolveCircleLifecycleState } from '../../../lib/circle-chain';
import { getClientIp } from '../../../lib/client-ip';
import { consumeRateLimit } from '../../../lib/rate-limit';
import { getCurrentRpcUrl } from '../../../services/network-config';
import { getPooledSuiClient } from '../../../services/sui-rpc-failover';
import { screenAddress, sanctionsErrorBody } from '../../../lib/sanctions';
import { isEmbargoedHeaders, embargoErrorBody } from '../../../lib/embargo';
import { getZkLoginSessionAccount } from '../../../lib/zklogin-session-registry';
import {
  getDriftStatusForIdentity,
  addressDriftErrorBody,
} from '../../../lib/zklogin-address-bindings';
import { hasAcceptedAllLegalDocs } from '../../../lib/legal-acceptance-server';

type ResponseData = {
  success: boolean;
  message?: string;
  code?: string;
  error?: string;
  data?: Record<string, unknown>;
};

// Abuse guards: this endpoint is unauthenticated (the on-chain join is the
// source of truth), so validate shapes/lengths and throttle per IP+address.
// Cryptographic proof that the caller owns userAddress is follow-up scope.
const REQUESTS_PER_MINUTE = 5;
const MINUTE_WINDOW_MS = 60_000;

const suiAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{1,64}$/, 'Invalid Sui address format');

const createJoinRequestSchema = z.object({
  circleId: suiAddressSchema,
  circleName: z.string().trim().min(1).max(120),
  userAddress: suiAddressSchema,
  userName: z.string().trim().max(80).optional(),
});

async function getCircleJoinWindow(circleId: string): Promise<{
  isActive: boolean;
  isPausedAfterCycle: boolean;
}> {
  const client = getPooledSuiClient({ rpcUrl: getCurrentRpcUrl() });
  const circleObject = await client.getObject({
    id: circleId,
    options: { showContent: true },
  });

  if (!circleObject.data?.content || !('fields' in circleObject.data.content)) {
    throw new Error('Could not load circle details');
  }

  const lifecycle = resolveCircleLifecycleState(
    circleObject.data.content.fields as Record<string, unknown>,
  );

  return {
    isActive: lifecycle.isActive,
    isPausedAfterCycle: lifecycle.isPausedAfterCycle,
  };
}

// Check if we're running on localhost
const isLocalhost = () => {
  return process.env.NODE_ENV === 'development' || 
         process.env.VERCEL_ENV === 'development' ||
         !process.env.DATABASE_URL;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const parsed = createJoinRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid fields'
      });
    }
    const { circleId, circleName, userAddress, userName } = parsed.data;

    // Throttle before any RPC/database work.
    const rateOutcome = await consumeRateLimit({
      key: `join-request:${getClientIp(req)}:${userAddress.toLowerCase()}`,
      limit: REQUESTS_PER_MINUTE,
      windowMs: MINUTE_WINDOW_MS,
    });
    if (!rateOutcome.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rateOutcome.resetMs / 1000)));
      return res.status(429).json({
        success: false,
        message: 'Too many join requests. Please wait a moment and try again.'
      });
    }

    // OFAC screen (docs/sanctions-program.md) — before any DB write.
    if (isEmbargoedHeaders((name) => req.headers[name] as string | undefined)) {
      const body = embargoErrorBody();
      return res.status(403).json({ success: false, message: body.message, code: body.code, error: body.error });
    }
    // Fail CLOSED: joining is a new commitment, so an unscreened join is
    // not an acceptable outcome. Unlike claim/refund/recovery, nothing is
    // stranded by making the member retry in a minute.
    const screen = await screenAddress(userAddress, 'circle_join', { failClosed: true });
    if (screen.blocked) {
      if (screen.reason === 'unavailable') {
        // Not a match — screening could not run. Say so, so the member
        // retries instead of believing they have been permanently refused.
        return res.status(503).json({
          success: false,
          code: 'SCREENING_UNAVAILABLE',
          error: 'SCREENING_UNAVAILABLE',
          message: 'We could not complete a required compliance check. Please try again shortly.',
        });
      }
      const body = sanctionsErrorBody();
      return res.status(403).json({ success: false, message: body.message, code: body.code, error: body.error });
    }

    // Legal acceptance, enforced server-side for the first time. The gate
    // existed only as a React modal (`LegalAcceptanceGate`), which a caller
    // hitting this endpoint directly never sees — and `hasAcceptedAllLegalDocs`
    // had zero callers, so the acceptance records were written but never
    // checked. Joining a circle is exactly the commitment the terms cover.
    // Identity comes from the session cookie, never the request body — a
    // body-supplied sub/aud would let a caller assert someone else's
    // acceptance. A caller with no session is left to the existing
    // address-based checks rather than being hard-failed, since this
    // endpoint has never required a session and doing so here would be a
    // separate behavioural change.
    const identity = await getZkLoginSessionAccount(req.cookies['session-id']);
    if (identity) {
      const legal = await hasAcceptedAllLegalDocs(identity.sub, identity.aud);
      if (!legal.accepted) {
        return res.status(403).json({
          success: false,
          code: 'LEGAL_ACCEPTANCE_REQUIRED',
          error: 'LEGAL_ACCEPTANCE_REQUIRED',
          message: 'Please accept the current terms before joining a circle.',
          data: { missing: legal.missing },
        });
      }

      // Address-drift gate. Joining is a new commitment, so it fails closed
      // for the same reason the sanctions screen above does: a member whose
      // identity now resolves to a different address would be committing
      // deposits at an account they may not realise is new, while their
      // existing funds sit at the old one. Fund-access paths (claim, refund,
      // recovery, withdrawal) are deliberately never gated this way.
      const drift = await getDriftStatusForIdentity({
        iss: identity.iss ?? null,
        sub: identity.sub,
        provider: identity.provider,
        userAddress: identity.userAddr,
      });
      if (drift.drifted) {
        const body = addressDriftErrorBody(drift.previousAddresses);
        return res.status(409).json({
          success: false,
          code: body.error,
          error: body.error,
          message: body.message,
          data: { previousAddresses: body.previousAddresses },
        });
      }
    }

    const circleJoinWindow = await getCircleJoinWindow(circleId);
    if (circleJoinWindow.isActive && !circleJoinWindow.isPausedAfterCycle) {
      return res.status(409).json({
        success: false,
        message: 'This circle is currently active. New members can only join when the circle is paused between cycles or inactive.'
      });
    }

    console.log(`[DEBUG] Creating join request for circle: ${circleId}, user: ${userAddress}`);
    console.log(`[DEBUG] Is localhost: ${isLocalhost()}`);

    let joinRequest = null;

    if (isLocalhost()) {
      // Use local SQLite database service for localhost
      console.log('[DEBUG] Using local SQLite database service');
      try {
        const localRequest = {
          circleId,
          circleName,
          userAddress,
          userName: userName || 'Anonymous',
          requestDate: Date.now(),
          status: 'pending' as const
        };
        
        joinRequest = databaseService.createJoinRequest(localRequest);
        console.log(`[DEBUG] SQLite join request created:`, joinRequest);
        
        if (!joinRequest) {
          throw new Error('Failed to create join request in SQLite database');
        }
      } catch (sqliteError) {
        console.error('[DEBUG] SQLite database error:', sqliteError);
        return res.status(500).json({
          success: false,
          message: 'Local database error: ' + (sqliteError as Error).message
        });
      }
    } else {
      // Use PostgreSQL database for production
      console.log('[DEBUG] Using PostgreSQL database for production');
      try {
        joinRequest = await joinRequestDatabase.createJoinRequest(
          circleId,
          circleName,
          userAddress,
          userName || 'Anonymous',
          'pending'
        );
      } catch (dbError) {
        console.error('[DEBUG] PostgreSQL database error:', dbError);
        return res.status(500).json({
          success: false,
          message: 'Database connection failed'
        });
      }
    }

    console.log(`[DEBUG] Join request created successfully: ${joinRequest ? `ID: ${joinRequest.id}` : 'No ID returned'}`);
    if (joinRequest) {
      console.log(`[DEBUG] Join request details:`, JSON.stringify(joinRequest));
    }

    return res.status(200).json({
      success: true,
      data: joinRequest ? { id: joinRequest.id } : { id: 0 }
    });
  } catch (error) {
    console.error('Error creating join request:', error);
    
    return res.status(500).json({
      success: false,
      message: 'Failed to create join request: ' + (error as Error).message
    });
  }
} 
