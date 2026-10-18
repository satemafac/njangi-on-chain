import { NextApiRequest, NextApiResponse } from 'next';
import { SetupData, AccountData, OAuthProvider } from '@/services/zkLoginService';
import { enokiZkLoginService, ClientSigningRequiredError } from '@/services/enokiZkLoginService';
import {
  getCurrentNetwork,
  NetworkType
} from '@/services/network-config';
// Phase 4 cleanup: Ember vault response helpers and config were orphaned
// when deployToEmberVault / requestEmberRedemption dispatch cases were
// stubbed to 410 Gone. Re-import here if a separately audited yield
// product reintroduces those flows.
import { getCanonicalBaseOrigin, normalizeOrigin, preferCanonicalOrigin } from '@/lib/canonical-host';
import { SuiNetworkUnavailableError } from '@/lib/sui-epoch';
import {
  countZkLoginSessions,
  deleteZkLoginSession,
  deleteZkLoginSessionsForUser,
  getZkLoginSession,
  hasZkLoginSession,
  setZkLoginSession,
} from '@/lib/zklogin-session-registry';
import { screenAddress, sanctionsErrorBody } from '@/lib/sanctions';
import {
  checkAddressDrift,
  alertDrift,
} from '@/lib/zklogin-address-bindings';
import {
  disabledResponse,
  isLegacyRailEnabled,
  isSwapsEnabled,
} from '@/config/feature-flags';

/**
 * Raised when the proof-issuance screen blocks a login. Distinct from a
 * generic failure so the handler can answer 403 rather than 500 — the
 * request succeeded, the answer is no.
 */
class SanctionsBlockedAtLoginError extends Error {
  constructor() {
    super('Sanctions screen blocked this address at proof issuance');
    this.name = 'SanctionsBlockedAtLoginError';
  }
}

/**
 * Member-initiated swap routing, gated by NEXT_PUBLIC_SWAPS_ENABLED.
 *
 * Swaps are a supported feature (production enables them) — this switch is
 * for disabling routing per environment, e.g. a venue outage or an
 * unvetted new integration, not for retiring the capability.
 *
 * Safe to flip either way: nothing here holds user funds, so a blocked swap
 * just leaves the member with the coins they already had.
 */
const SWAP_ACTIONS = new Set([
  'executeStablecoinSwap',
  'swapAndDepositCetus',
  'swapAndDepositDeepBook',
  'configureStablecoinSwap',
  'toggleAutoSwap',
  'executeSwapOnly',
]);

/**
 * Legacy custody/payments rail, gated by LEGACY_RAIL_ENABLED (default off).
 *
 * Deliberately CONTRIBUTIONS ONLY. Payouts (adminTriggerPayout) and the
 * recovery paths (executeRecovery, triggerAutoRelease, emergency stop voting)
 * are NOT listed and must never be: money already committed to a legacy
 * circle has to remain claimable after the rail stops accepting new deposits.
 * A kill switch that traps funds is a worse compliance outcome than the
 * feature it was meant to retire.
 */
const LEGACY_RAIL_ACTIONS = new Set([
  'contributeFromCustody',
  'depositUsdcDirect',
  'depositStablecoin',
]);

/**
 * Dispatcher actions that used to sign a transaction with a server-held key.
 *
 * Their handlers were removed on 2026-10-17. Sessions no longer carry a
 * server-held key, `enokiZkLoginService.sendTransaction` throws
 * ClientSigningRequiredError unconditionally, and the guard in the handler
 * answered every existing session with 409 before any of these handlers ran,
 * so the handlers were unreachable. The names stay so a stale client gets an
 * actionable 409 instead of "Unknown action". Do not add an action here to
 * build a new server signer: new transactions are built and signed in the
 * browser (src/lib/zklogin-tx-builders.ts and signLocallyWithBuilder in
 * src/services/zkLoginClient.ts are the pattern).
 *
 * The only client that still POSTs any of these is SimplifiedSwapUI
 * (depositStablecoin, executeSwapOnly), which renders only when
 * NEXT_PUBLIC_ENABLE_SWAP_AND_DEPOSIT_FORM is set. It gets the same 409 it
 * got before. src/__tests__/api/capability-gate-partitioning.test.ts keeps
 * the swap and legacy-rail gates honest about which components POST what.
 */
const SERVER_SIGNING_ACTIONS = new Set([
  'activateCircle', 'adminApproveMember', 'adminApproveMembers', 'adminRemoveMember',
  'adminSetMaxMembers', 'adminTriggerPayout', 'configureStablecoinSwap',
  'contributeFromCustody', 'contributeToCycleEscrow', 'deleteCircle',
  'depositStablecoin', 'depositUsdcDirect', 'executeRecovery',
  'executeStablecoinSwap', 'executeSwapOnly', 'finalizeAndRedeemCycleEscrow',
  'openCycleEscrow', 'paySecurityDeposit', 'proposeEmergencyStop',
  'reorderRotationPositions', 'resumeCycle', 'sendTokens',
  'sendTransaction', 'setRotationPosition', 'swapAndDepositCetus',
  'swapAndDepositDeepBook', 'toggleAutoSwap', 'triggerAutoRelease',
  'voteEmergencyStop',
]);

// Constants
// (A `MAX_EPOCH = 2` constant lived here to support the proof-expiry check in
// `validateSession`. That check never fired and has been removed; the real
// epoch check lives in `EnokiZkLoginService.validateAccountData`, which uses
// its own MAX_EPOCH. Two disagreeing copies of this constant was itself a bug.)
const PROCESSING_COOLDOWN = 30000; // 30 seconds between processing attempts for the same session

// Durable session store. The previous implementation persisted session
// material — including ephemeral private keys — to `./zklogin-sessions.json`
// in development. That made the server an effective custodian and was
// removed as part of the Phase 1 compliance redesign. The Vercel/serverless
// migration (June 2026) moved sessions into Postgres, encrypted at rest —
// see `src/lib/zklogin-session-registry.ts`. Without DATABASE_URL (dev) the
// registry falls back to the historic in-memory Map.
//
// The registry is shared so other API routes (e.g. the WhatsApp admin
// endpoints) can resolve the caller's session-verified address without
// trusting client-supplied identity.
const sessions = {
  get: (key: string) => getZkLoginSession(key),
  set: (key: string, value: SetupData & { account?: AccountData }) =>
    setZkLoginSession(key, value),
  delete: (key: string) => deleteZkLoginSession(key),
  has: (key: string) => hasZkLoginSession(key),
  size: () => countZkLoginSessions(),
};

// Resolve the caller's session or throw. Only handleCallback uses it now: the
// server-signing actions it also validated were retired (see SERVER_SIGNING_ACTIONS).
async function validateSession(sessionId: string | undefined, action: string): Promise<SetupData & { account?: AccountData }> {
  if (!sessionId) {
    throw new Error('No session ID provided');
  }

  const session = await sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found for ${action}`);
  }

  return session;
}

// Helper to set session cookie
function setSessionCookie(res: NextApiResponse, sessionId: string) {
  const cookieValue = `session-id=${sessionId}`;
  const cookieOptions = [
    cookieValue,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    // Set a long Max-Age since we handle expiration with maxEpoch
    'Max-Age=86400',
  ];

  if (process.env.NODE_ENV === 'production') {
    cookieOptions.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieOptions.join('; '));
}

// Helper to clear session cookie
function clearSessionCookie(res: NextApiResponse) {
  res.setHeader('Set-Cookie', 'session-id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

// Helper to clean up old sessions for a user (single active session per
// user). Delegates to the registry so the delete spans every instance.
function cleanupUserSessions(userAddr: string, currentSessionId: string): Promise<void> {
  return deleteZkLoginSessionsForUser(userAddr, currentSessionId);
}

// Add after MAX_EPOCH constant
const PROCESSING_SESSIONS = new Map<string, { startTime: number, promise: Promise<AccountData> }>();

function resolveRequestOrigin(req: NextApiRequest, explicitOrigin?: unknown): string | undefined {
  if (typeof explicitOrigin === 'string' && explicitOrigin.trim() !== '') {
    const resolvedExplicitOrigin = preferCanonicalOrigin(explicitOrigin);
    if (resolvedExplicitOrigin) {
      return resolvedExplicitOrigin;
    }

    console.warn('Ignoring invalid explicit auth origin:', explicitOrigin);
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = req.headers.host;
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const resolvedHost = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || host;

  if (!resolvedHost) {
    return getCanonicalBaseOrigin() ?? undefined;
  }

  const resolvedProto = proto || (resolvedHost.includes('localhost') ? 'http' : 'https');
  return preferCanonicalOrigin(`${resolvedProto}://${resolvedHost}`) ?? normalizeOrigin(`${resolvedProto}://${resolvedHost}`) ?? getCanonicalBaseOrigin() ?? undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, jwt, provider, network, origin } = req.body;
    let sessionId = req.cookies['session-id'];

    // Always log the current session state for debugging. Never the
    // session id itself: the cookie value is the session's credential.
    console.log('Current session state:', {
      action,
      hasSessionCookie: Boolean(sessionId),
      hasSession: sessionId ? await sessions.has(sessionId) : false,
      sessionCount: await sessions.size()
    });

    const instance = enokiZkLoginService;

    // Capability gates. Enforced here, ahead of the dispatcher, so a disabled
    // feature is unreachable by direct API call and not merely hidden in the
    // UI — which is how the Coinbase ramp stayed open while appearing off.
    if (SWAP_ACTIONS.has(action) && !isSwapsEnabled()) {
      return res.status(503).json(
        disabledResponse(
          'swaps',
          'Token swaps are disabled. Fund your circle with the contribution currency directly.',
        ),
      );
    }
    if (LEGACY_RAIL_ACTIONS.has(action) && !isLegacyRailEnabled()) {
      return res.status(503).json(
        disabledResponse(
          'legacy_rail',
          'This contribution route has been retired. Please use the current round escrow.',
        ),
      );
    }

    // Retired server-signing actions. Their handlers were deleted on
    // 2026-10-17: the signing path has thrown ClientSigningRequiredError
    // unconditionally since sessions stopped carrying a server-held key, and
    // this guard already answered every existing session before a handler
    // could run. Answering every caller here keeps the one actionable 409 a
    // stale client can act on, instead of "Unknown action".
    if (SERVER_SIGNING_ACTIONS.has(action)) {
      console.log('Rejecting retired server-signing action:', { action, hasSession: Boolean(sessionId) });
      return res.status(409).json({
        error:
          'This action must be signed in your browser. Please refresh the page and try again.',
        code: 'CLIENT_SIGNING_REQUIRED',
      });
    }

    switch (action) {
      case 'beginLogin':
        // Validate the browser-supplied key material at the boundary. The
        // service guards this too, but throwing from there surfaces as a 500
        // via the outer catch — and a malformed request is the caller's fault,
        // not a server fault. Returning 500 would page on client errors and
        // bury real faults in monitoring noise.
        if (
          typeof req.body.ephemeralPublicKey !== 'string' ||
          !req.body.ephemeralPublicKey ||
          typeof req.body.randomness !== 'string' ||
          !req.body.randomness
        ) {
          return res.status(400).json({
            error:
              'A browser-generated ephemeral public key and randomness are required. Refresh the page and try signing in again.',
            code: 'EPHEMERAL_KEY_REQUIRED',
          });
        }

        // Generate new session ID and clear any existing sessions
        sessionId = crypto.randomUUID();
        setSessionCookie(res, sessionId);
        const requestedNetwork: NetworkType =
          network === 'testnet' || network === 'mainnet' ? network : getCurrentNetwork();
        const requestOrigin = resolveRequestOrigin(req, origin);

        // The ephemeral keypair is generated in the browser; we receive only
        // the public half. Nothing stored against this session can produce a
        // user signature.
        const { loginUrl, setupData: initialSetup } = await instance.beginLogin(
          provider as OAuthProvider,
          requestedNetwork,
          requestOrigin,
          {
            ephemeralPublicKey: req.body.ephemeralPublicKey,
            randomness: req.body.randomness,
          },
        );

        // Log the setup data being stored
        console.log('Storing initial setup:', {
          provider: initialSetup.provider,
          maxEpoch: initialSetup.maxEpoch,
          network: initialSetup.network,
          protocolVersion: initialSetup.protocolVersion,
          ephemeralPublicKey: initialSetup.ephemeralPublicKey,
        });

        await sessions.set(sessionId, initialSetup);
        return res.status(200).json({ loginUrl, maxEpoch: initialSetup.maxEpoch });

      case 'handleCallback':
        if (!jwt) {
          return res.status(400).json({ error: 'JWT is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please start the login process again.' });
        }

        try {
          // Check if this session is already being processed to prevent duplicate processing
          const processingInfo = PROCESSING_SESSIONS.get(sessionId);
          if (processingInfo) {
            const elapsedTime = Date.now() - processingInfo.startTime;
            
            // If the process has been running for less than the cooldown, return a "processing" status
            if (elapsedTime < PROCESSING_COOLDOWN) {
              console.log(`Session is already being processed (${elapsedTime}ms elapsed)`);
              return res.status(202).json({ 
                status: 'processing',
                message: 'Authentication is being processed. Please wait.' 
              });
            } else {
              // If it's been too long, remove the processing lock and try again
              console.log('Session processing timed out, retrying');
              PROCESSING_SESSIONS.delete(sessionId);
            }
          }

          // Get and validate setup data
          const savedSetup = await validateSession(sessionId, 'handleCallback');
          
          // Preserve the auth session network from beginLogin. Only use the callback
          // request network as a fallback if the session did not already store one.
          if (!savedSetup.network && (network === 'testnet' || network === 'mainnet')) {
            const savedSetupWithNetwork = savedSetup as SetupData & {
              account?: AccountData;
              network?: NetworkType;
            };
            savedSetupWithNetwork.network = network;
            console.log('📱 handleCallback: Backfilled missing session network from callback request:', network);
          } else {
            console.log('📱 handleCallback: Using existing session network:', savedSetup.network || 'not set');
          }
          
          // If we already have account data, return it immediately
          if (savedSetup.account) {
            console.log('Session already has account data, returning immediately');
            return res.status(200).json(savedSetup.account);
          }
          
          // Create a promise that will resolve with the account data
          const processPromise = (async () => {
            const result = await instance.handleCallback(jwt, savedSetup);

            // Sanctions screen at PROOF ISSUANCE.
            //
            // Once transactions are signed in the browser there is no
            // server choke point left on the money paths — the old
            // screens sat inside `sendTransaction`, which now 409s for
            // every current session, so they enforce nothing. This is the
            // replacement: refusing to hand back zkProofs. Without proofs
            // the client cannot assemble a zkLogin signature, so nothing
            // reaches the chain.
            //
            // Refusing to authenticate is not the same as seizing or
            // freezing assets — we never gain the ability to move the
            // user's funds, we simply decline to help. That distinction is
            // what keeps this compatible with the non-custodial posture.
            //
            // Deliberately fail-OPEN: this gate covers claim, refund and
            // recovery too, so failing it closed during an outage would
            // strand members' committed funds. New commitments are screened
            // separately with failClosed. Honest limitation: proofs live
            // one Sui epoch (~24h), so a user listed immediately after
            // login retains a usable proof until it expires. The weekly
            // retro-sweep is what catches that window.
            const screen = await screenAddress(result.address, 'proof_issuance');
            if (screen.blocked) {
              if (sessionId) await sessions.delete(sessionId);
              clearSessionCookie(res);
              throw new SanctionsBlockedAtLoginError();
            }

            // Address-drift detection.
            //
            // MUST run before cleanupUserSessions below. That call wipes the
            // user's prior session rows, and zklogin_sessions carries a 24h
            // TTL — which is exactly why drift was silent until now: the
            // previous address was destroyed before the new one existed, so
            // nothing could ever compare them. The bindings table is the
            // durable record; ordering this first keeps the two consistent.
            //
            // Deliberately does NOT block the login. The user must be able to
            // get in to see the explanation, and — more importantly — to
            // reach claim, refund and recovery. The server-side commitment
            // routes (circle join requests, ramp sessions, WhatsApp circle
            // linking) refuse separately, each through getDriftStatusFor*.
            // Circle creation and contributions are signed in the browser and
            // have no server gate. Fail-closed on new commitments where the
            // server sees them, fail-open on fund access: the same split
            // src/lib/sanctions.ts uses, for the same reason.
            const drift = await checkAddressDrift({
              iss: result.iss ?? null,
              sub: result.sub,
              aud: result.aud,
              provider: savedSetup.provider,
              userAddress: result.address,
            });
            if (drift.drifted) {
              await alertDrift(
                {
                  iss: result.iss ?? null,
                  sub: result.sub,
                  provider: savedSetup.provider,
                },
                drift,
              );
            }

            // Clean up any existing sessions for this user
            await cleanupUserSessions(result.address, sessionId);

            // Create the account data object.
            //
            // No `ephemeralPrivateKey`. It used to be carried through for
            // legacy v1 sessions; nothing can act on it now that
            // enokiZkLoginService.sendTransaction throws unconditionally, and
            // dropping it means key material has no route into server storage
            // at all. The browser merges in its own key. Do not reintroduce a
            // server-side source for this field.
            const accountData: AccountData = {
              provider: savedSetup.provider,
              userAddr: result.address,
              zkProofs: result.zkProofs,
              userSalt: result.userSalt,
              sub: result.sub,
              aud: result.aud,
              iss: result.iss,
              maxEpoch: savedSetup.maxEpoch,
              picture: result.picture,
              name: result.name
            };
            
            // Store the account data in the session
            await sessions.set(sessionId, { ...savedSetup, account: accountData });
            
            // Clean up the processing lock
            PROCESSING_SESSIONS.delete(sessionId);
            
            return accountData;
          })();
          
          // Store the processing promise and timestamp
          PROCESSING_SESSIONS.set(sessionId, {
            startTime: Date.now(),
            promise: processPromise
          });
          
          // Wait for the promise to resolve
          const accountData = await processPromise;
          
          console.log('Storing account data:', {
            address: accountData.userAddr,
            maxEpoch: savedSetup.maxEpoch,
            protocolVersion: savedSetup.protocolVersion ?? 1,
            ephemeralPublicKey: savedSetup.ephemeralPublicKey,
          });
          
          return res.status(200).json(accountData);
        } catch (err) {
          // Clean up the processing lock if there was an error
          if (sessionId) {
            PROCESSING_SESSIONS.delete(sessionId);
          }
          
          // A sanctions block is a policy decision, not a fault. Surface it
          // as 403 with the standard body rather than letting it fall
          // through to the generic 500 handler, which would read as an
          // outage and invite a retry.
          if (err instanceof SanctionsBlockedAtLoginError) {
            return res.status(403).json(sanctionsErrorBody());
          }

          console.error('HandleCallback error:', err);
          // If session validation failed, clear cookie and session
          if (err instanceof Error && err.message.includes('Session')) {
            clearSessionCookie(res);
            if (sessionId) await sessions.delete(sessionId);
          }
          throw err;
        }

      // Phase 4 cleanup: deployToEmberVault and requestEmberRedemption
      // were the admin-only Ember vault yield deployment + redemption flows.
      // The yield product line was removed in the Phase 1 compliance redesign
      // (njangi_yield_integration deleted, custody admin levers gutted), so
      // these dispatch cases now respond 410 Gone for callers that still ship
      // legacy buttons. Reintroduce as a separately licensed product if and
      // when audited yield support returns.
      case 'deployToEmberVault':
      case 'requestEmberRedemption':
        return res.status(410).json({
          error: 'Ember vault flow was removed in the non-custodial Phase 1 redesign.',
          code: 'EMBER_FLOW_REMOVED',
        });

      case 'executeSwap':
      case 'sendSerializedTransaction':
        // Removed: this endpoint signed arbitrary caller-supplied transaction
        // bytes with the session's ephemeral key, gated only by possession of
        // the session cookie. That made it an unconditional signing oracle
        // over the user's entire wallet — no Move-target allowlist, no
        // recipient constraint — so cookie theft was equivalent to wallet
        // theft.
        //
        // Every caller already builds its transaction in the browser, so they
        // now sign locally via `src/lib/zklogin-client-signer.ts`. An
        // allowlisted server signer was considered and rejected: Cetus routing
        // is mostly non-MoveCall commands into packages we do not control, so
        // any allowlist permissive enough to admit it would also admit
        // transfers to an attacker.
        return res.status(410).json({
          error:
            'Server-side transaction signing has been removed. Please refresh the page so your client can sign locally.',
          code: 'SERIALIZED_TX_REMOVED',
          requireRelogin: true,
        });

      // Phase 4 cleanup: withdrawWalletFunds and returnSecurityDeposit were
      // admin-discretionary custody operations that targeted Move functions
      // deleted in Phase 1 (njangi_custody::withdraw_all,
      // njangi_payments::admin_payout_security_deposit_{sui,stablecoin}).
      // Non-custodial Phase 1 makes the admin an incompatible caller;
      // member-initiated recovery liveness is the supported refund path.
      case 'withdrawWalletFunds':
      case 'returnSecurityDeposit':
        return res.status(410).json({
          error: 'Admin-discretionary custody operations were removed in the non-custodial Phase 1 redesign. Use the member-initiated recovery flow instead.',
          code: 'CUSTODY_OP_REMOVED',
        });

      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (err) {
    // The signing path throws this rather than returning; it means the caller
    // must sign locally, which is a 409 and not a server fault. Mapped here so
    // any route into it gives the same answer as the guard above, instead of
    // an opaque 500.
    if (err instanceof ClientSigningRequiredError) {
      return res.status(409).json({
        error:
          'This action must be signed in your browser. Please refresh the page and try again.',
        code: 'CLIENT_SIGNING_REQUIRED',
      });
    }
    // Sign-in could not read the chain's epoch from any source: an upstream
    // outage, not a fault here. A 503 with a code lets the button say so.
    if (err instanceof SuiNetworkUnavailableError) {
      console.warn('API error:', err.message);
      return res.status(503).json({ error: err.message, code: err.code });
    }
    console.error('API error:', err);
    return res.status(500).json({ 
      error: err instanceof Error ? err.message : 'An unexpected error occurred' 
    });
  }
} 
