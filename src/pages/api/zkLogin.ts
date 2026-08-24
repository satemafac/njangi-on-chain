import { NextApiRequest, NextApiResponse } from 'next';
import { SetupData, AccountData, OAuthProvider } from '@/services/zkLoginService';
import { ZkLoginError } from '@/services/zkLoginClient';
import { SuiClient } from '@mysten/sui/client';
import {
  getCirclePackageId,
  getObjectTransactionPackageId,
  getPackageLookupIdsForCurrentNetwork,
} from '../../services/circle-service';
import { AggregatorClient, Env } from '@cetusprotocol/aggregator-sdk';
import BN from 'bn.js';
import { Transaction } from '@mysten/sui/transactions';
import { enokiZkLoginService, ClientSigningRequiredError } from '@/services/enokiZkLoginService';
import {
  getCurrentNetwork,
  getCurrentRpcUrl,
  getCurrentCoinTypes,
  getCurrentCetusConfig,
  getCurrentTokens,
  setCurrentNetwork,
  NetworkType,
  getCurrentPackageId,
  getPackageIdForNetwork
} from '@/services/network-config';
import { getHealthySuiClient } from '@/services/sui-rpc-failover';
// Phase 4 cleanup: Ember vault response helpers and config were orphaned
// when deployToEmberVault / requestEmberRedemption dispatch cases were
// stubbed to 410 Gone. Re-import here if a separately audited yield
// product reintroduces those flows.
import { getCanonicalBaseOrigin, normalizeOrigin, preferCanonicalOrigin } from '@/lib/canonical-host';
import {
  normalizePackageId,
  resolveUpgradeAwarePackageId,
} from '@/lib/circle-chain';
import { getCircleConfigFields } from '@/lib/circle-config';
import { getMinimumAutoReleaseDelayMsForMoveCycleLength } from '@/lib/auto-release';
import { normalizeRecoveryDelegateAddress } from '@/lib/recovery-delegate';
import { isResolvedSuiObjectId } from '@/lib/sui-object-id';
import {
  countZkLoginSessions,
  deleteZkLoginSession,
  deleteZkLoginSessionsForUser,
  getZkLoginSession,
  hasZkLoginSession,
  setZkLoginSession,
} from '@/lib/zklogin-session-registry';
import {
  assertCanCreateCircle,
  assertWithinMemberLimit,
  entitlementErrorBody,
  EntitlementError,
} from '@/lib/entitlement-gate';
import { screenAddress, sanctionsErrorBody } from '@/lib/sanctions';
import {
  checkAddressDrift,
  alertDrift,
  getDriftStatusForIdentity,
  addressDriftErrorBody,
} from '@/lib/zklogin-address-bindings';
import { isEmbargoedHeaders, embargoErrorBody } from '@/lib/embargo';
import {
  disabledResponse,
  isLegacyRailEnabled,
  isSwapsEnabled,
} from '@/config/feature-flags';

// Add at the top with other imports
interface RPCError extends Error {
  code?: number;
}

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
 * Every dispatcher action that signs a transaction with a server-held key.
 *
 * Deliberately an explicit denylist rather than "everything except beginLogin
 * and handleCallback": adding a new signing action should be a conscious act,
 * and an omission here fails safe (the action runs and hits the typed
 * ClientSigningRequiredError from `validateAccountData`) rather than silently
 * signing for a session that should not be signable.
 *
 * The end state is that this set is empty and the actions are gone. Until
 * then, membership here means "not yet migrated to client-side signing".
 *
 * As of 2026-08-03 the only members still POSTed by any client are
 * depositStablecoin and executeSwapOnly, both in SimplifiedSwapUI, which
 * renders only when NEXT_PUBLIC_ENABLE_SWAP_AND_DEPOSIT_FORM is set (it is
 * not, in production). So enabling that flag resurrects a path that will 409
 * rather than work. If you turn it on, migrate its actions to the client
 * signer first — the builders in src/lib/zklogin-tx-builders.ts and the
 * signLocallyWithBuilder helper in src/services/zkLoginClient.ts are the
 * pattern.
 *
 * This comment previously also listed depositUsdcDirect as unreachable. It
 * was not: the contribute page reached it for every USDC security deposit,
 * and the legacy-rail gate answered 503 — so USDC deposits were dead in
 * production while this file asserted they could not be. A live browser run
 * caught it; no unauthenticated probe could have, because the gate fires
 * before the account check that shapes an anonymous response.
 *
 * The lesson is narrower than "audit harder": reachability claims about
 * CLIENT code do not belong in a server file, where nothing recomputes them.
 * src/__tests__/api/capability-gate-partitioning.test.ts now asserts that no
 * gated action is POSTed from an ungated component.
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

// Minimum slippage for aggregator transactions
const MIN_AGGREGATOR_SLIPPAGE = 30; // 0.3% minimum slippage to ensure transaction success
const SUI_COIN_TYPE = '0x2::sui::SUI';
const USDC_COIN_TYPE = getCurrentCoinTypes().USDC;

// Network-aware helper functions
function getNetworkAggregatorRouter(): string {
  return getCurrentCetusConfig().aggregatorRouter;
}

// Remove unused function - using getCurrentCetusConfig().globalConfig directly

function getNetworkRpcUrl(): string {
  return getCurrentRpcUrl();
}

async function resolveCirclePackageIdForTransaction(args: {
  context: string;
  network: NetworkType;
  circleId?: string | null;
  objectPackageId?: string | null;
  requestedPackageId?: string | null;
  userAddress?: string | null;
}): Promise<string> {
  const { context, network, circleId, objectPackageId, requestedPackageId, userAddress } = args;
  const networkPackageId =
    normalizePackageId(getPackageIdForNetwork(network)) ??
    normalizePackageId(getCurrentPackageId()) ??
    getPackageIdForNetwork(network);

  let detectedPackageId = normalizePackageId(objectPackageId);

  if (!detectedPackageId && circleId) {
    try {
      detectedPackageId = normalizePackageId(
        await getCirclePackageId(circleId, userAddress ?? undefined),
      );
    } catch (error) {
      console.warn(`[${context}] Failed to resolve package ID from circle ${circleId}:`, error);
    }
  }

  if (!detectedPackageId) {
    detectedPackageId = normalizePackageId(requestedPackageId);
  }

  if (!detectedPackageId) {
    return networkPackageId;
  }

  const resolvedPackageId = resolveUpgradeAwarePackageId({
    network,
    objectPackageId: detectedPackageId,
    currentPackageId: networkPackageId,
  });

  if (resolvedPackageId !== detectedPackageId) {
    console.log(
      `[${context}] Routing upgraded lineage package ${detectedPackageId} to current package ${resolvedPackageId}`
    );
  } else {
    console.log(
      `[${context}] Using package ID ${resolvedPackageId} for transaction routing`
    );
  }

  return resolvedPackageId;
}

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

// Add session validation helper with better error handling
async function validateSession(sessionId: string | undefined, action: string): Promise<SetupData & { account?: AccountData }> {
  if (!sessionId) {
    throw new Error('No session ID provided');
  }

  const session = await sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found for ${action}`);
  }

  // Different validation rules based on action
  if (action === 'sendTransaction' || action === 'deleteCircle' || action === 'sendTokens') {
    // No ephemeral-key check: sessions no longer carry one, and the signing
    // path it guarded now throws unconditionally. What still matters is that
    // the session resolves to a real account, so requests stay bound to a
    // server-verified identity rather than a client-supplied one.
    if (!session.account) {
      throw new Error('Invalid session: missing account data');
    }
    
    // Proof expiry is NOT checked here. A previous check in this spot compared
    // `maxEpoch - 2 >= maxEpoch`, which is never true, so it expired
    // nothing while reading like a control. The real check needs the live chain
    // epoch and runs in `EnokiZkLoginService.validateAccountData` immediately
    // before signing; the session registry separately enforces its own TTL.
    // Do not add a lookalike check here without an RPC epoch read.

    // Validate proof components
    if (!session.account.zkProofs?.proofPoints?.a?.length ||
        !session.account.zkProofs?.proofPoints?.b?.length ||
        !session.account.zkProofs?.proofPoints?.c?.length) {
      throw new Error('Invalid session: missing or invalid proof points');
    }
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

// Add aggregator SDK helper
let aggregatorSDK: AggregatorClient | null = null;
let aggregatorSDKNetwork: NetworkType | null = null;

// Get network-aware USDC coin types
function getAlternateUsdcCoinTypes(): string[] {
  const networkTokens = getCurrentTokens();
  const networkCoinTypes = getCurrentCoinTypes();
  
  return [
    networkCoinTypes.USDC,
    networkTokens.USDC,
    ...(networkTokens.USDT ? [networkTokens.USDT] : [])
  ];
}

// Get network-aware pool addresses
function getDirectPoolAddresses(): Record<string, string[]> {
  const cetusConfig = getCurrentCetusConfig();
  const network = getCurrentNetwork();
  
  if (network === 'testnet') {
    return {
      'USDC': [
        cetusConfig.pools.SUI_USDC,
        '0x2e041f3fd93646dcc877f783c1f2b7fa62d30271bdef1f21ef002cebf857bded',
        '0x6fb54be7106bb59863f196bc5e2e34426c15f3d5b9662150ed81d5417411dbd7',
        '0xaf5a9c7e4b265955acb0b371ab5ccb76a240b9735c8e9c8978ce866bed19a9a9'
      ],
    };
  } else {
    return {
      'USDC': [
        cetusConfig.pools.SUI_USDC,
        ...(cetusConfig.pools.SUI_USDT ? [cetusConfig.pools.SUI_USDT] : [])
      ],
    };
  }
}

// Initialize Aggregator SDK with network awareness
async function getAggregatorSDK(): Promise<AggregatorClient> {
  const network = getCurrentNetwork();

  if (aggregatorSDK && aggregatorSDKNetwork === network) {
    return aggregatorSDK;
  }
  
  try {
    const sdkOptions = {
      rpcUrl: getNetworkRpcUrl(),
      aggregatorPackageId: getNetworkAggregatorRouter(),
      env: network === 'testnet' ? Env.Testnet : Env.Mainnet
    };
    
    aggregatorSDK = new AggregatorClient(sdkOptions);
    aggregatorSDKNetwork = network;
    console.log(`Aggregator SDK initialized successfully for ${network}`);
    return aggregatorSDK;
  } catch (error) {
    console.error('Failed to initialize Aggregator SDK:', error);
    throw new Error('Aggregator service initialization failed');
  }
}

// Helper function to safely create SuiClient instances
async function createSuiClient(targetNetwork?: NetworkType): Promise<SuiClient> {
  const network = targetNetwork ?? getCurrentNetwork();

  try {
    const { client, rpcUrl, isFallback } = await getHealthySuiClient(
      network,
      'api.zkLogin.createSuiClient',
    );
    console.log('Creating SuiClient with URL:', rpcUrl, isFallback ? '(fallback)' : '(primary)');
    return client;
  } catch (error) {
    console.error('Error creating SuiClient:', error);
    throw error;
  }
}

// Removed with the `sendSerializedTransaction` action: these parsed
// caller-supplied transaction payloads so the server could sign them. Nothing
// server-side accepts a client-built transaction any more — clients sign their
// own. Do not reintroduce without reading the note on that case.

// When using swapAndDepositCetus, replace accessing the private suiClient directly with the proper API
const getEpochData = async (): Promise<{ epoch: string }> => {
  try {
    const suiClient = await createSuiClient();
    return await suiClient.getLatestSuiSystemState();
  } catch (error) {
    console.error('Error in getEpochData:', error);
    throw error;
  }
};

// Add this helper function after getEpochData
const checkPoolLiquidity = async () => {
  try {
    console.log('Checking available liquidity in SUI-USDC pools...');
    const suiClient = await createSuiClient();
    
    // First check which pools actually exist
    const validPools = [];
    for (const poolId of getDirectPoolAddresses()['USDC']) {
      try {
        const objectData = await suiClient.getObject({
          id: poolId,
          options: { showContent: true }
        });
        
        if (objectData && objectData.data) {
          validPools.push(poolId);
          
          // Log pool details
          if (objectData.data.content && 'fields' in objectData.data.content) {
            const fields = objectData.data.content.fields as {
              reserve_x?: string;
              reserve_y?: string;
              coin_a_type?: string;
              coin_b_type?: string;
              current_sqrt_price?: string;
              current_tick_index?: number;
              // For pools with different field names
              reserve_a?: string;
              reserve_b?: string;
              sqrt_price?: string;
              liquidity?: string;
              [key: string]: unknown;
            };
            
            // Try to determine which fields hold the liquidity values
            const reserveA = fields.reserve_x || fields.reserve_a;
            const reserveB = fields.reserve_y || fields.reserve_b;
            const liquidityField = fields.liquidity;
            const sqrtPrice = fields.current_sqrt_price || fields.sqrt_price;
            const tickIndex = fields.current_tick_index;
            
            console.log(`Pool ${poolId} exists and has the following liquidity:`);
            if (reserveA) console.log(`- Reserve A: ${BigInt(reserveA) / BigInt(1e9)} SUI`);
            if (reserveB) console.log(`- Reserve B: ${BigInt(reserveB) / BigInt(1e6)} USDC`);
            if (liquidityField) console.log(`- Liquidity value: ${liquidityField}`);
            if (sqrtPrice) console.log(`- Sqrt Price: ${sqrtPrice}`);
            if (tickIndex !== undefined) console.log(`- Current tick index: ${tickIndex}`);
            
            // If we can determine coin types, log those too
            const coinTypeA = fields.coin_a_type || fields.coin_type_a;
            const coinTypeB = fields.coin_b_type || fields.coin_type_b;
            if (coinTypeA) console.log(`- Coin A type: ${coinTypeA}`);
            if (coinTypeB) console.log(`- Coin B type: ${coinTypeB}`);
            
            console.log(`Full pool data:`, fields);
          } else {
            console.log(`Pool ${poolId} exists but content fields not accessible`);
          }
        } else {
          console.log(`Pool ${poolId} does not exist or is not accessible`);
        }
      } catch (err) {
        console.log(`Error checking pool ${poolId}:`, err instanceof Error ? err.message : String(err));
      }
    }
    
    return validPools;
  } catch (error) {
    console.error('Error checking pool liquidity:', error);
    return [];
  }
};

// Add a utility function for formatting micro units (for USDC with 6 decimals)
function formatMicroUnits(amount: bigint): string {
  return (Number(amount) / 1_000_000).toFixed(6);
}

type RoutingCurrency = 'USDC' | 'SUI';

type CurrencyResolution = {
  currency: RoutingCurrency;
  source: 'query.currency' | 'body.currency' | 'body.useUSDC' | 'default';
};

type CoinBalanceEntry = {
  coinObjectId: string;
  balance: string;
};

function getQueryValue(param: string | string[] | undefined): string | undefined {
  if (Array.isArray(param)) {
    return param[0];
  }
  return typeof param === 'string' ? param : undefined;
}

function normalizeCurrency(raw: unknown): RoutingCurrency | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const upper = raw.trim().toUpperCase();
  if (upper === 'USDC') return 'USDC';
  if (upper === 'SUI') return 'SUI';
  return null;
}

function resolveRequestCurrency(req: NextApiRequest): CurrencyResolution {
  const queryCurrency = normalizeCurrency(getQueryValue(req.query.currency));
  if (queryCurrency) {
    return { currency: queryCurrency, source: 'query.currency' };
  }

  const body = req.body as { currency?: unknown; useUSDC?: unknown } | undefined;
  const bodyCurrency = normalizeCurrency(body?.currency);
  if (bodyCurrency) {
    return { currency: bodyCurrency, source: 'body.currency' };
  }

  if (typeof body?.useUSDC === 'boolean') {
    return {
      currency: body.useUSDC ? 'USDC' : 'SUI',
      source: 'body.useUSDC',
    };
  }

  return { currency: 'USDC', source: 'default' };
}

function logCurrencySelection(action: string, resolution: CurrencyResolution, context: Record<string, unknown>) {
  console.log(
    '[currency-selection]',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      selectedCurrency: resolution.currency,
      source: resolution.source,
      ...context,
    })
  );
}

function parsePositiveNumber(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

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

function usdCentsToMicroUsdc(usdCents: number): bigint {
  // 1 cent == 10,000 microUSDC
  return BigInt(Math.floor(usdCents)) * BigInt(10_000);
}

function getConfigUsdCents(configFields: Record<string, unknown> | null, preferredKeys: string[]): number {
  if (!configFields) return 0;

  for (const key of preferredKeys) {
    const value = parsePositiveNumber(configFields[key]);
    if (value > 0) return value;
  }

  return 0;
}

async function getAllCoinsByType(
  suiClient: SuiClient,
  owner: string,
  coinType: string
): Promise<CoinBalanceEntry[]> {
  const allCoins: CoinBalanceEntry[] = [];
  let cursor: string | null = null;

  do {
    const page = await suiClient.getCoins({
      owner,
      coinType,
      cursor,
    });

    allCoins.push(
      ...page.data.map((coin) => ({
        coinObjectId: coin.coinObjectId,
        balance: coin.balance,
      }))
    );

    cursor = page.hasNextPage ? page.nextCursor ?? null : null;
  } while (cursor);

  return allCoins;
}

// Phase 4 cleanup: EmberSourceAsset / EmberDeployPayload / EmberRedeemPayload
// types, along with isValidObjectId, validateAdminWalletContext, and
// mapEmberAbortMessage helpers, were orphaned when the Ember vault dispatch
// cases were stubbed to 410 Gone. Recreate these alongside a separately
// audited yield product if and when one is reintroduced.

// Lightweight address + object helpers retained for the few callers that
// still need them (adminRemoveMember, security deposit context checks).
// Left deliberately outside the deleted Ember helpers so the compiler
// can see them.
function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function parseU64Amount(value: unknown, fieldName: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${fieldName} must be non-negative`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`${fieldName} must be a non-negative integer`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`${fieldName} must be an integer string`);
    }
    return BigInt(trimmed);
  }
  throw new Error(`${fieldName} is required`);
}

function extractMoveFields(content: unknown): Record<string, unknown> | null {
  if (!content || typeof content !== 'object' || !('fields' in content)) {
    return null;
  }
  const fields = (content as { fields: Record<string, unknown> }).fields;
  const value = fields.value;
  if (value && typeof value === 'object' && 'fields' in value) {
    return (value as { fields: Record<string, unknown> }).fields;
  }
  return fields;
}

function extractIdLike(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const maybeId = value as { id?: unknown };
    if (typeof maybeId.id === 'string') return maybeId.id;
    if (maybeId.id && typeof maybeId.id === 'object' && 'id' in maybeId.id) {
      const nestedId = (maybeId.id as { id?: unknown }).id;
      if (typeof nestedId === 'string') return nestedId;
    }
  }
  return null;
}


type SecurityDepositCoinKind = 'sui' | 'stablecoin';

function parseOptionalU64Amount(value: unknown): bigint | null {
  if (value === null || typeof value === 'undefined') return null;

  try {
    return parseU64Amount(value, 'amount');
  } catch {
    return null;
  }
}

function getCircleMembersTableIdFromContent(content: unknown): string | null {
  const fields = extractMoveFields(content);
  if (!fields) return null;

  const membersField = fields.members;
  const membersFields = extractMoveFields(membersField);
  return extractIdLike(membersFields?.id) || extractIdLike(membersField);
}

async function getMemberSecurityDepositState(
  suiClient: SuiClient,
  circleContent: unknown,
  memberAddress: string,
): Promise<{ hasPaidDeposit: boolean; depositBalance: bigint }> {
  const membersTableId = getCircleMembersTableIdFromContent(circleContent);
  if (!membersTableId) {
    return { hasPaidDeposit: false, depositBalance: 0n };
  }

  try {
    const memberField = await suiClient.getDynamicFieldObject({
      parentId: membersTableId,
      name: { type: 'address', value: normalizeAddress(memberAddress) }
    });

    const memberFields = extractMoveFields(memberField.data?.content);
    if (!memberFields) {
      return { hasPaidDeposit: false, depositBalance: 0n };
    }

    return {
      hasPaidDeposit: memberFields.deposit_paid === true,
      depositBalance: parseOptionalU64Amount(memberFields.deposit_balance) ?? 0n,
    };
  } catch (error) {
    console.warn('[security-deposit] Failed to read member deposit state:', error);
    return { hasPaidDeposit: false, depositBalance: 0n };
  }
}

function getWalletStablecoinTarget(walletContent: unknown): string | null {
  const walletFields = extractMoveFields(walletContent);
  if (!walletFields) return null;

  const stablecoinConfigFields = extractMoveFields(walletFields.stablecoin_config);
  const target = stablecoinConfigFields?.target_coin_type;
  return typeof target === 'string' && target.trim() !== '' ? target.trim() : null;
}

function resolveStablecoinCoinType(targetCoinType?: string | null): string {
  if (targetCoinType && targetCoinType.includes('::')) {
    return targetCoinType;
  }

  const normalizedTarget = targetCoinType?.trim().toUpperCase();
  const coinTypes = getCurrentCoinTypes();
  const tokens = getCurrentTokens();

  switch (normalizedTarget) {
    case 'USDT':
      return tokens.USDT || tokens.USDC || coinTypes.USDC;
    case 'SUI_USDE':
      return coinTypes.SUI_USDE || tokens.SUI_USDE || coinTypes.USDC;
    case 'USDC':
    default:
      return coinTypes.USDC || tokens.USDC;
  }
}

function inferDepositCoinKindFromAmount(
  depositBalance: bigint,
  circleContent: unknown,
  configFields: Record<string, unknown> | null
): SecurityDepositCoinKind | null {
  if (depositBalance <= 0n) return null;

  const circleFields = extractMoveFields(circleContent);
  const expectedSui = parseOptionalU64Amount(configFields?.security_deposit ?? circleFields?.security_deposit);
  const expectedUsdCents = parseOptionalU64Amount(configFields?.security_deposit_usd ?? circleFields?.security_deposit_usd);
  const expectedStablecoin = expectedUsdCents !== null ? expectedUsdCents * 10_000n : null;

  if (expectedSui !== null && depositBalance === expectedSui && depositBalance !== expectedStablecoin) {
    return 'sui';
  }

  if (expectedStablecoin !== null && depositBalance === expectedStablecoin && depositBalance !== expectedSui) {
    return 'stablecoin';
  }

  return null;
}

async function inferDepositCoinKindFromEvents(
  suiClient: SuiClient,
  packageId: string,
  circleId: string,
  walletId: string,
  memberAddress: string,
): Promise<SecurityDepositCoinKind | null> {
  try {
    const normalizedCircleId = normalizeAddress(circleId);
    const normalizedWalletId = normalizeAddress(walletId);
    const normalizedMember = normalizeAddress(memberAddress);

    const depositEvents = await suiClient.queryEvents({
      query: { MoveEventType: `${packageId}::njangi_custody::CoinDeposited` },
      limit: 200
    });

    const matchingEvent = [...depositEvents.data]
      .filter((event) => {
        const parsed = event.parsedJson as Record<string, unknown> | null;
        if (!parsed) return false;

        const eventCircleId = typeof parsed.circle_id === 'string' ? normalizeAddress(parsed.circle_id) : null;
        const eventWalletId = typeof parsed.wallet_id === 'string' ? normalizeAddress(parsed.wallet_id) : null;
        const eventMember = typeof parsed.member === 'string' ? normalizeAddress(parsed.member) : null;

        return eventCircleId === normalizedCircleId &&
          eventWalletId === normalizedWalletId &&
          eventMember === normalizedMember;
      })
      .sort((a, b) => Number(b.timestampMs || 0) - Number(a.timestampMs || 0))[0];

    const parsed = matchingEvent?.parsedJson as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed.coin_type !== 'string') {
      return null;
    }

    return parsed.coin_type.toLowerCase() === 'sui' ? 'sui' : 'stablecoin';
  } catch (error) {
    console.warn('[security-deposit] Failed to infer deposit coin type from events:', error);
    return null;
  }
}

async function resolveMemberSecurityDepositContext(args: {
  suiClient: SuiClient;
  packageId: string;
  circleId: string;
  walletId: string;
  memberAddress: string;
  circleContent: unknown;
  walletContent: unknown;
}): Promise<{
  hasPaidDeposit: boolean;
  depositBalance: bigint;
  coinKind: SecurityDepositCoinKind | null;
  stablecoinTypeArg: string;
}> {
  const {
    suiClient,
    packageId,
    circleId,
    walletId,
    memberAddress,
    circleContent,
    walletContent,
  } = args;

  const memberState = await getMemberSecurityDepositState(suiClient, circleContent, memberAddress);
  const stablecoinTarget = getWalletStablecoinTarget(walletContent);
  const stablecoinTypeArg = resolveStablecoinCoinType(stablecoinTarget);

  if (!memberState.hasPaidDeposit || memberState.depositBalance <= 0n) {
    return {
      ...memberState,
      coinKind: null,
      stablecoinTypeArg,
    };
  }

  let configFields: Record<string, unknown> | null = null;
  try {
    configFields = await getCircleConfigFields(suiClient, circleId);
  } catch (error) {
    console.warn('[security-deposit] Failed to load circle config fields:', error);
  }

  const amountInferredKind = inferDepositCoinKindFromAmount(
    memberState.depositBalance,
    circleContent,
    configFields
  );

  const eventInferredKind = amountInferredKind || await inferDepositCoinKindFromEvents(
    suiClient,
    packageId,
    circleId,
    walletId,
    memberAddress
  );

  return {
    ...memberState,
    coinKind: eventInferredKind || (stablecoinTarget ? 'stablecoin' : 'sui'),
    stablecoinTypeArg,
  };
}

async function resolveRecoveryWalletCoinType(
  suiClient: SuiClient,
  walletId: string,
): Promise<string> {
  const walletResponse = await suiClient.getObject({
    id: walletId,
    options: { showContent: true },
  });

  if (!walletResponse.data?.content) {
    throw new Error('Failed to load custody wallet for recovery execution');
  }

  return resolveStablecoinCoinType(getWalletStablecoinTarget(walletResponse.data.content));
}

function mapSecurityDepositErrorMessage(errorStr: string, fallback = 'Transaction failed'): string {
  if (errorStr.includes(', 12)')) {
    return 'Insufficient security deposit balance available to return this deposit.';
  }
  if (errorStr.includes(', 7)') || errorStr.includes('ENotAdmin')) {
    return 'Only the circle admin can return security deposits';
  }
  if (errorStr.includes(', 58)')) {
    return 'Security deposits can only be returned when the circle is inactive or paused after a cycle. If this circle is already inactive, the deployed contract package may need to be updated.';
  }
  if (errorStr.includes(', 8)') || errorStr.includes(', 5)') || errorStr.includes('EMemberNotFound')) {
    return 'The specified address is not a member of this circle';
  }
  if (errorStr.includes(', 46)')) {
    return 'The custody wallet does not belong to this circle';
  }
  if (errorStr.includes(', 43)')) {
    return 'The custody wallet is not active';
  }
  if (errorStr.includes(', 59)')) {
    return 'No security deposit to return for this member';
  }
  if (errorStr.includes(', 60)')) {
    return 'Security deposit has already been returned';
  }
  if (errorStr.includes('ECircleIsActive') || errorStr.includes(', 2)')) {
    return 'Members can only be removed from inactive circles';
  }
  if (errorStr.includes('MoveAbort')) {
    const match = errorStr.match(/MoveAbort\([^,]+,\s*(\d+)\)/);
    return match ? `Smart contract error (code ${match[1]}): ${errorStr}` : `Smart contract error: ${errorStr}`;
  }

  return fallback;
}

const CLOCK_OBJECT_ID = "0x6"; // Sui system clock object ID

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, jwt, account, provider, circleData, circleId, newMaxMembers, network, origin } = req.body; // Add newMaxMembers and network
    let sessionId = req.cookies['session-id'];

    // Always log the current session state for debugging
    console.log('Current session state:', {
      action,
      sessionId,
      hasSession: sessionId ? await sessions.has(sessionId) : false,
      sessionCount: await sessions.size()
    });

    const instance = enokiZkLoginService;
    // Do not initialize Cetus SDK here since we're not using it directly

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

    // Sessions created after the ephemeral key moved into the browser carry no
    // server-held secret, so every server-signing action below is structurally
    // unable to run for them. Reject once, up front, with a code the client can
    // act on — rather than letting 30-odd handlers each fail late with a
    // generic 500 from deep inside the signing path.
    //
    // Previously this let legacy v1 sessions through, because they still
    // carried a server-held key. None do now — the key was dropped from the
    // session record and the signing path throws unconditionally — so every
    // server-signing action gets the same answer regardless of session vintage.
    if (sessionId && SERVER_SIGNING_ACTIONS.has(action)) {
      const existing = await sessions.get(sessionId);
      if (existing) {
        console.log('Rejecting server-signing action for client-signing session:', {
          action,
          protocolVersion: existing.protocolVersion ?? 2,
        });
        return res.status(409).json({
          error:
            'This action must be signed in your browser. Please refresh the page and try again.',
          code: 'CLIENT_SIGNING_REQUIRED',
        });
      }
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
          sessionId,
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
              console.log(`Session ${sessionId} is already being processed (${elapsedTime}ms elapsed)`);
              return res.status(202).json({ 
                status: 'processing',
                message: 'Authentication is being processed. Please wait.' 
              });
            } else {
              // If it's been too long, remove the processing lock and try again
              console.log(`Processing timeout for session ${sessionId}, retrying`);
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
            console.log(`Session ${sessionId} already has account data, returning immediately`);
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
            // reach claim, refund and recovery. Commitment surfaces (circle
            // create/join, contribute, ramp session) refuse separately via
            // assertNoAddressDrift. Fail-closed on new commitments, fail-open
            // on fund access: the same split src/lib/sanctions.ts uses, for
            // the same reason.
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
            sessionId,
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

      case 'sendTransaction':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          // Log the transaction attempt
          console.log('Attempting transaction:', {
            sessionId,
            address: account.userAddr,
            hasSession: await sessions.has(sessionId),
          });

          // Validate session with action context
          const session = await validateSession(sessionId, 'sendTransaction');
          
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.'
            });
          }

          // Verify session matches account data
          if (session.account.userAddr !== account.userAddr) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Session mismatch: Please refresh your authentication'
            });
          }

          // Handle network parameter if provided by frontend
          const requestedNetwork = req.body.network;
          if (requestedNetwork && (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet')) {
            console.log(`Frontend requested network: ${requestedNetwork}, current server network: ${getCurrentNetwork()}`);
          }

          // Validate monetary values before transaction
          const contribution = BigInt(circleData.contribution_amount);
          const contributionLocal = BigInt(circleData.contribution_amount_local || 0);
          const contributionUsd = BigInt(circleData.contribution_amount_usd || 0);
          const deposit = BigInt(circleData.security_deposit);
          const depositLocal = BigInt(circleData.security_deposit_local || 0);
          const depositUsd = BigInt(circleData.security_deposit_usd || 0);
          const autoReleaseEnabled =
            circleData.auto_release_enabled === true || circleData.auto_release_enabled === 'true';
          const autoReleaseDelayMs = BigInt(circleData.auto_release_delay_ms || 0);
          const cycleLengthValue = Number(circleData.cycle_length);
          const rawNextInCommand =
            typeof circleData.next_in_command === 'string' ? circleData.next_in_command : '';
          const normalizedNextInCommand = normalizeRecoveryDelegateAddress(rawNextInCommand);
          const rawTargetAmountLocal =
            typeof circleData.target_amount_local === 'object' && circleData.target_amount_local !== null
              ? circleData.target_amount_local.some
              : circleData.target_amount_local;
          const targetAmountLocalValue =
            rawTargetAmountLocal === undefined ||
            rawTargetAmountLocal === null ||
            rawTargetAmountLocal === '' ||
            rawTargetAmountLocal === 0 ||
            rawTargetAmountLocal === '0'
              ? null
              : BigInt(rawTargetAmountLocal);
          
          // Debug logging to understand value conversions
          console.log("Circle Creation - Monetary Values:", {
            contributionAmountSUI: Number(contribution) / 1e9,  // Convert MIST to SUI
            contributionAmountMIST: contribution.toString(),
            contributionLocalCurrency: contributionLocal.toString(),
            contributionLocalAmount: Number(contributionLocal) / 100,
            contributionAmountUSD: Number(contributionUsd) / 100,
            securityDepositSUI: Number(deposit) / 1e9,  // Convert MIST to SUI
            securityDepositMIST: deposit.toString(),
            securityDepositLocalCurrency: depositLocal.toString(),
            securityDepositLocalAmount: Number(depositLocal) / 100,
            securityDepositUSD: Number(depositUsd) / 100,
            currencyType: circleData.currency_type || 'USD',
            autoReleaseEnabled,
            autoReleaseDelayMs: autoReleaseDelayMs.toString(),
            expectedFormat: "The contract expects SUI values in MIST format (9 decimals)"
          });
          
          // Basic validation for reasonable SUI amounts
          if (contributionLocal > 0) {
            const estSuiPrice = Number(contributionLocal) / 100 / (Number(contribution) / 1e9);
            console.log(`Estimated SUI price from values: $${estSuiPrice.toFixed(4)} per SUI`);
          }
          
          if (contribution <= BigInt(0) || deposit <= BigInt(0)) {
            return res.status(400).json({ 
              error: 'Invalid amount: Contribution and security deposit must be greater than 0'
            });
          }

          if (contributionLocal <= BigInt(0) || depositLocal <= BigInt(0)) {
            return res.status(400).json({ 
              error: 'Invalid local currency amount: Contribution and security deposit local currency values must be greater than 0'
            });
          }

          if (autoReleaseEnabled && autoReleaseDelayMs <= BigInt(0)) {
            return res.status(400).json({
              error: 'Invalid auto-release delay: Delay must be greater than 0 when auto-release is enabled'
            });
          }

          if (autoReleaseEnabled) {
            const minimumAutoReleaseDelayMs = getMinimumAutoReleaseDelayMsForMoveCycleLength(cycleLengthValue);
            if (minimumAutoReleaseDelayMs === null) {
              return res.status(400).json({
                error: 'Invalid cycle length: Unable to validate auto-release delay for this circle cadence'
              });
            }

            if (autoReleaseDelayMs <= BigInt(minimumAutoReleaseDelayMs)) {
              return res.status(400).json({
                error: `Invalid auto-release delay: Delay must be greater than the selected cycle length (${Math.round(minimumAutoReleaseDelayMs / (24 * 60 * 60 * 1000))} days minimum)`
              });
            }

          } else if (rawNextInCommand.trim().length > 0 && !normalizedNextInCommand) {
            return res.status(400).json({
              error: 'Invalid next-in-command wallet: Enter a valid Sui wallet address'
            });
          }

          if (contributionUsd <= BigInt(0) || depositUsd <= BigInt(0)) {
            return res.status(400).json({ 
              error: 'Invalid USD equivalent amount: USD values must be greater than 0'
            });
          }

          // Make sure we're using the session's account data rather than what was sent
          // This ensures we have the latest and valid account data
          console.log('Using account data from session for transaction');

          // Check for missing proof components
          if (!session.account.zkProofs?.proofPoints?.a || 
              !session.account.zkProofs?.proofPoints?.b ||
              !session.account.zkProofs?.proofPoints?.c ||
              !session.account.zkProofs?.issBase64Details ||
              !session.account.zkProofs?.headerBase64) {
            console.error('Missing proof components in session account data');
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({
              error: 'Invalid proof data in session. Please login again.',
              requireRelogin: true
            });
          }

          // Ensure salt and address seed can be generated
          try {
            BigInt(session.account.userSalt);
          } catch (error) {
            console.error('Invalid salt format:', error);
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({
              error: 'Invalid account data: salt is not properly formatted. Please login again.',
              requireRelogin: true
            });
          }

          // Log transaction parameters for debugging
          console.log('Transaction parameters:', {
            circleType: circleData.circle_type,
            contributionAmount: contribution.toString(),
            contributionAmountLocal: contributionLocal.toString(),
            contributionAmountUSD: contributionUsd.toString(),
            securityDeposit: deposit.toString(),
            securityDepositLocal: depositLocal.toString(),
            securityDepositUSD: depositUsd.toString(),
            maxMembers: circleData.max_members,
            // Add cycle debugging
            cycleLength: circleData.cycle_length,
            cycleDay: circleData.cycle_day,
            currencyType: circleData.currency_type,
            autoReleaseEnabled,
            autoReleaseDelayMs: autoReleaseDelayMs.toString()
          });

          // OFAC screen (docs/sanctions-program.md): refuse SDN-listed
          // wallets and embargoed regions before any side effect. Unlike
          // the billing gate below this is a compliance control — the
          // screen itself fails open only on infrastructure errors (see
          // src/lib/sanctions.ts for the compensating retro-sweep).
          if (isEmbargoedHeaders((name) => req.headers[name] as string | undefined)) {
            return res.status(403).json(embargoErrorBody());
          }
          {
            const screen = await screenAddress(session.account.userAddr, 'circle_create');
            if (screen.blocked) {
              return res.status(403).json(sanctionsErrorBody());
            }
          }

          // Address-drift gate. Creating a circle is a NEW COMMITMENT, so it
          // fails closed: if this identity previously resolved to a different
          // address, the user may be about to build a circle at an account
          // they do not realise is new, while their existing funds sit
          // elsewhere. Claim, refund, recovery and withdrawal are never gated
          // this way — see src/lib/zklogin-address-bindings.ts.
          //
          // HONEST LIMIT: like the billing gate below, this is a SOFT gate.
          // create_circle is a public Move entry point and the Phase 2
          // client-side signer submits straight to RPC, so a determined
          // client bypasses this route entirely. The hard coverage for a
          // drifted user is the join gate (the join queue is ours) plus the
          // AddressDriftGate interstitial, which the create page is not
          // exempt from. This check is honest friction, not security.
          {
            const drift = await getDriftStatusForIdentity({
              iss: session.account.iss ?? null,
              sub: session.account.sub,
              provider: session.account.provider,
              userAddress: session.account.userAddr,
            });
            if (drift.drifted) {
              return res.status(409).json(addressDriftErrorBody(drift.previousAddresses));
            }
          }

          // Billing SOFT gate (create-circle path): requested member cap vs
          // the plan's maxMembers, and the admin's existing circle count vs
          // maxCircles. create_circle is a public Move entry point and the
          // Phase 2 client-side signer submits straight to RPC, so a
          // client-side signer bypasses this entirely — it is product
          // friction for the upgrade funnel, NOT security. No-op while
          // NEXT_PUBLIC_BILLING_ENABLED is off; fails open on billing
          // infrastructure errors. Recovery/claim/withdraw/contribute paths
          // are deliberately never gated (ToS-promised).
          try {
            await assertCanCreateCircle({
              identity: {
                sub: session.account.sub,
                aud: session.account.aud,
                userAddress: session.account.userAddr,
              },
              requestedMaxMembers: Number(circleData.max_members ?? 0),
              network:
                requestedNetwork === 'testnet' || requestedNetwork === 'mainnet'
                  ? requestedNetwork
                  : getCurrentNetwork(),
            });
          } catch (gateError) {
            if (gateError instanceof EntitlementError) {
              return res.status(402).json(entitlementErrorBody(gateError));
            }
            console.warn(
              '[zkLogin] createCircle billing gate skipped (fail-open):',
              gateError,
            );
          }

          // Attempt to send the transaction with network override support
          try {
            // Temporarily set the network to match the frontend request
            const originalNetwork = getCurrentNetwork();
            let txResult;
            
            try {
              if (requestedNetwork && requestedNetwork !== originalNetwork) {
                console.log(`Temporarily switching server network from ${originalNetwork} to ${requestedNetwork} for transaction`);
                setCurrentNetwork(requestedNetwork as NetworkType);
                // Reinitialize the EnokiZkLoginService with the new network configuration
                instance.initializeWithNetwork();
              }
              
              // Get the package ID that matches the current/requested network
              const packageIdToUse = getCurrentPackageId();
              console.log(`Using package ID ${packageIdToUse} for circle creation (network: ${getCurrentNetwork()})`);
              
              txResult = await instance.sendTransaction(
                session.account,
                (txb: Transaction) => {
                  txb.setSender(session.account!.userAddr);
                  
                  // Validate cycle_day before using it
                  const cycleDay = circleData.cycle_day !== undefined ? circleData.cycle_day : 1; // Default to 1 if undefined
                  console.log('Using cycle_day value:', cycleDay);
                  
                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::create_circle`,
                    arguments: [
                      txb.pure.string(circleData.name),
                      txb.pure.u64(contribution),
                      txb.pure.string(circleData.currency_type || 'USD'),  // currency_type: vector<u8>
                      txb.pure.u64(contributionLocal),
                      txb.pure.u64(contributionUsd),     // contribution_amount_usd
                      txb.pure.u64(deposit),
                      txb.pure.u64(depositLocal),
                      txb.pure.u64(depositUsd),          // security_deposit_usd
                      txb.pure.u64(circleData.cycle_length),
                      txb.pure.u64(cycleDay), // Use validated cycleDay
                      txb.pure.u8(circleData.circle_type),
                      txb.pure.u64(circleData.max_members),
                      txb.pure.u8(circleData.rotation_style),
                      txb.pure.vector('bool', circleData.penalty_rules),
                      txb.pure.option('u8', circleData.goal_type?.some),
                      txb.pure.option('u64', circleData.target_amount?.some ? BigInt(circleData.target_amount.some) : null),
                      txb.pure.option('u64', targetAmountLocalValue),
                      txb.pure.option('u64', circleData.target_date?.some ? BigInt(circleData.target_date.some) : null),
                      txb.pure.bool(circleData.verification_required),
                      txb.pure.bool(autoReleaseEnabled),
                      txb.pure.u64(autoReleaseDelayMs),
                      txb.object("0x6")  // Clock object
                    ]
                  });
                }
              );
            } finally {
              // Always restore the original network and reinitialize the service
              if (requestedNetwork && requestedNetwork !== originalNetwork) {
                console.log(`Restoring server network back to ${originalNetwork}`);
                setCurrentNetwork(originalNetwork as NetworkType);
                instance.initializeWithNetwork();
              }
            }
            
            console.log('Transaction successful:', txResult);
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
          } catch (txError) {
            console.error('Transaction execution error:', txError);
            
            // Check if the error is related to proof verification
            if (txError instanceof Error && 
                (txError.message.includes('proof verify failed') ||
                 txError.message.includes('Session expired') ||
                 txError.message.includes('re-authenticate'))) {
              
              // Clear the session for authentication errors
              await sessions.delete(sessionId);
              clearSessionCookie(res);
              
              return res.status(401).json({
                error: 'Your session has expired. Please login again.',
                requireRelogin: true
              });
            }
            
            // For other errors, keep the session but return error
            return res.status(500).json({ 
              error: txError instanceof Error ? txError.message : 'Failed to execute transaction',
              requireRelogin: false
            });
          }
        } catch (err) {
          // Check for any signature/proof/verification related errors
          if (err instanceof Error && 
              (err.message.toLowerCase().includes('invalid user signature') || 
               err.message.toLowerCase().includes('groth16 proof verify failed') ||
               err.message.toLowerCase().includes('signature is not valid') ||
               err.message.toLowerCase().includes('cryptographic error') ||
               (err as RPCError).code === -32002)) {
            // Clear the session and return 401
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({ 
              error: 'Your session has expired. Please try again from the dashboard.',
              requireRelogin: true
            });
          }
          // Handle other transaction errors
          console.error('Transaction error:', err);
          return res.status(500).json({ 
            error: 'Failed to execute transaction. Please try again.',
            details: err instanceof Error ? err.message : 'Unknown error',
            requireRelogin: false
          });
        }

      case 'deleteCircle':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          // Log the transaction attempt
          console.log('Attempting circle deletion:', {
            sessionId,
            address: account.userAddr,
            circleId: req.body.circleId,
            hasSession: await sessions.has(sessionId),
          });

          // Validate session with action context
          const session = await validateSession(sessionId, 'deleteCircle');
          
          // Get important parameters from the request
          const circleId = req.body.circleId;
          let walletId = req.body.walletId; // This might be undefined
          const circlePackageId = req.body.packageId; // Circle-specific package ID from frontend
          
          if (!circleId) {
            return res.status(400).json({ error: 'Circle ID is required' });
          }
          
          console.log(`Circle-specific package ID from frontend: ${circlePackageId || '(not provided)'}`);

          
          // Handle network parameter if provided by frontend
          const requestedNetwork = req.body.network;
          if (requestedNetwork && (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet')) {
            console.log(`Frontend requested network: ${requestedNetwork}, current server network: ${getCurrentNetwork()}`);
          }
          
          // Get the correct RPC URL for the requested network
          const networkToUse = requestedNetwork || getCurrentNetwork();
          const suiClient = await createSuiClient(networkToUse);
          console.log(`Using ${networkToUse} network for wallet lookup`);
          
          // If no wallet ID was provided, try to find it from events
          if (!walletId) {
            console.log("No wallet ID provided, trying to find it from events");
            
            try {
              const detectedCirclePackageId =
                circlePackageId ||
                await getCirclePackageId(circleId, session.account!.userAddr);
              const packageIdsForEvents =
                getPackageLookupIdsForCurrentNetwork(detectedCirclePackageId);

              for (const packageIdForEvents of packageIdsForEvents) {
                console.log(`Querying wallet events with package ID: ${packageIdForEvents}`);
                const events = await suiClient.queryEvents({
                  query: {
                    MoveEventType: `${packageIdForEvents}::njangi_custody::CustodyWalletCreated`
                  },
                  limit: 100
                });
                
                console.log(`Found ${events.data.length} CustodyWalletCreated events`);
                
                // Look through events to find the wallet ID for this circle
                for (const event of events.data) {
                  if (event.parsedJson && typeof event.parsedJson === 'object' && 
                      'circle_id' in event.parsedJson && 'wallet_id' in event.parsedJson) {
                    const eventData = event.parsedJson as { circle_id: string, wallet_id: string };
                    if (eventData.circle_id === circleId) {
                      walletId = eventData.wallet_id;
                      console.log(`Found wallet ID ${walletId} for circle ${circleId} from events`);
                      break;
                    }
                  }
                }

                if (walletId) {
                  break;
                }
              }
              
              if (!walletId) {
                console.log(`Could not find wallet ID for circle ${circleId} from events`);
                return res.status(404).json({ 
                  error: 'Cannot delete: Unable to find required wallet data. The circle may be in an inconsistent state.',
                  details: 'No wallet ID found in events for this circle.'
                });
              }
        } catch (error) {
              console.error('Error finding wallet ID from events:', error);
              return res.status(500).json({ 
                error: 'Failed to find wallet data for this circle',
                details: error instanceof Error ? error.message : String(error)
              });
            }
          }
          
          // Verify the wallet exists and belongs to the circle
          let walletObj;
          try {
            walletObj = await suiClient.getObject({
              id: walletId,
              options: { showContent: true }
            });
            
            if (!walletObj.data?.content) {
              // Check if this might be a network mismatch issue
              const currentNetwork = getCurrentNetwork();
              console.warn(`Wallet ${walletId} not found on ${currentNetwork} network - may be from a different network`);
              
              // Instead of returning an error, try to delete the circle without wallet verification
              // This handles the case where wallet exists on different network
              console.log(`Proceeding with circle deletion without wallet verification (network: ${currentNetwork})`);
              walletObj = null; // Signal to skip wallet-specific validations
            }
          } catch (error) {
            // REFUSE — a failed read must not disarm a safety gate on a
            // destructive, irreversible operation. The checks below are
            // what prove this wallet belongs to this circle and is empty
            // before the circle is deleted; skipping them because the read
            // errored is the one interpretation with no safe outcome.
            // (A genuine not-found above is different: that is a verified
            // absence and keeps its existing network-mismatch handling.)
            const currentNetwork = getCurrentNetwork();
            console.error(`Error fetching wallet ${walletId} on ${currentNetwork}; refusing to delete unverified:`, error);
            return res.status(503).json({
              error: 'WALLET_VERIFICATION_UNAVAILABLE',
              message:
                'We could not verify this circle\'s wallet just now, so nothing was deleted. Please try again shortly.',
            });
          }
          
          // Only perform wallet validation if walletObj exists (network match)
          if (walletObj && walletObj.data?.content) {
            // Check if wallet belongs to the circle
            const walletContent = walletObj.data.content as { fields?: { circle_id?: string, balance?: { fields?: { value?: string } } } };
            if (walletContent?.fields?.circle_id !== circleId) {
              console.error(`Wallet ${walletId} does not belong to circle ${circleId}`);
              return res.status(400).json({ 
                error: 'Wallet does not belong to this circle'
              });
            }
            
            // NEW: Check wallet balance before attempting deletion
            if (walletContent?.fields?.balance?.fields?.value) {
              const balance = BigInt(walletContent.fields.balance.fields.value);
              if (balance > 0) {
                console.log(`Wallet has non-zero balance: ${balance}`);
                return res.status(400).json({
                  error: 'Cannot delete: The wallet has SUI balance. Please withdraw all funds first.',
                  code: 'EWalletHasBalance',
                  walletBalance: balance.toString(),
                  walletId: walletId
                });
              }
            }
            
            // NEW: Check for any coins in dynamic fields
            try {
              // Get dynamic fields of the wallet to check for coins
              const dynamicFields = await suiClient.getDynamicFields({
                parentId: walletId
              });
              
              // Check for any coin_objects field
              for (const field of dynamicFields.data) {
                if (field.name && 
                    typeof field.name === 'object' && 
                    'type' in field.name && 
                    field.name.type && 
                    (field.name.type.includes('coin_objects') || 
                     field.name.type.includes('Coin<') ||
                     field.objectType?.includes('Coin<'))) {
                  
                  console.log(`Found coin field in wallet: ${field.objectId}`);
                  return res.status(400).json({
                    error: 'Cannot delete: The wallet has coins stored in dynamic fields. Please withdraw all funds first.',
                    code: 'EWalletHasBalance',
                    walletId: walletId
                  });
                }
              }
            } catch (error) {
              console.warn('Error checking wallet dynamic fields:', error);
              // Continue with deletion attempt even if we can't check dynamic fields
            }
          }

          // Verify both circle and wallet exist on current network before transaction
          try {
            const currentNetwork = requestedNetwork || getCurrentNetwork(); // Use requested network if provided
            console.log(`Verifying objects exist on ${currentNetwork} network before transaction`);
            
            // Check if circle exists on current network
            let circleExists = false;
            try {
              const circleCheck = await suiClient.getObject({
                id: circleId,
                options: { showContent: true }
              });
              circleExists = circleCheck.data?.content != null;
            } catch {
              console.log(`Circle ${circleId} not found on ${currentNetwork}`);
            }
            
            // Check if wallet exists on current network (only if we have a wallet)
            let walletExists = walletObj != null; // If we validated wallet above, it exists
            if (!walletExists && walletId) {
              try {
                const walletCheck = await suiClient.getObject({
                  id: walletId,
                  options: { showContent: true }
                });
                walletExists = walletCheck.data?.content != null;
              } catch {
                console.log(`Wallet ${walletId} not found on ${currentNetwork}`);
              }
            }
            
            // If objects don't exist on current network, return appropriate error
            if (!circleExists) {
              return res.status(400).json({
                error: `Circle ${circleId} does not exist on ${currentNetwork} network. Please switch to the correct network.`,
                code: 'ENetworkMismatch',
                currentNetwork: currentNetwork,
                circleId: circleId
              });
            }
            
            if (walletId && !walletExists) {
              return res.status(400).json({
                error: `Wallet ${walletId} does not exist on ${currentNetwork} network. Please switch to the correct network.`,
                code: 'ENetworkMismatch',
                currentNetwork: currentNetwork,
                walletId: walletId
              });
            }
            
            console.log(`Creating transaction block for delete_circle with circle ID: ${circleId} and wallet ID: ${walletId}`);
            
            // Temporarily set the network to match the frontend request
            const originalNetwork = getCurrentNetwork();
            let txResult;
            
            try {
              if (requestedNetwork && requestedNetwork !== originalNetwork) {
                console.log(`Temporarily switching server network from ${originalNetwork} to ${requestedNetwork} for transaction`);
                setCurrentNetwork(requestedNetwork as NetworkType);
                // Reinitialize the EnokiZkLoginService with the new network configuration
                instance.initializeWithNetwork();
              }
              
              // Use the package ID from the frontend if provided, otherwise fetch from blockchain
              const packageIdToUse = await resolveCirclePackageIdForTransaction({
                context: 'deleteCircle',
                network: getCurrentNetwork(),
                circleId,
                requestedPackageId: circlePackageId,
                userAddress: session.account!.userAddr,
              });
              
              console.log(`Using package ID ${packageIdToUse} for circle ${circleId} (from frontend: ${!!circlePackageId})`);
              
              txResult = await instance.sendTransaction(
                session.account!,
                (txb: Transaction) => {
                  txb.setSender(session.account!.userAddr);
                  
                  // Log transaction creation details
                  console.log(`Building moveCall with package: ${packageIdToUse}, module: njangi_circles, function: delete_circle`);
                  console.log(`Using circleId: ${circleId} and walletId: ${walletId} as arguments`);
                  
                  // Include both circle and wallet in the call with proper object flags
                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::delete_circle`,
                    arguments: [
                      txb.object(circleId),
                      txb.object(walletId)
                    ]
                  });
                  
                  console.log('Transaction block built successfully');
                },
                { gasBudget: 100000000 } // Increase gas budget for delete operation
              );
            } finally {
              // Always restore the original network and reinitialize the service
              if (requestedNetwork && requestedNetwork !== originalNetwork) {
                console.log(`Restoring server network back to ${originalNetwork}`);
                setCurrentNetwork(originalNetwork as NetworkType);
                instance.initializeWithNetwork();
              }
            }
            
            console.log('Circle deletion successful:', JSON.stringify(txResult, null, 2));
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
          } catch (txError) {
            console.error('Circle deletion error detail:', txError);
            console.error('Error type:', typeof txError);
            console.error('Error message:', txError instanceof Error ? txError.message : String(txError));
            console.error('Error name:', txError instanceof Error ? txError.name : 'Not an Error object');
            console.error('Error stack:', txError instanceof Error ? txError.stack : 'No stack trace');
            
            // Check if the error is related to proof verification
            if (txError instanceof Error && 
                (txError.message.includes('proof verify failed') ||
                 txError.message.includes('Session expired') ||
                 txError.message.includes('re-authenticate'))) {
              
              // Clear the session for authentication errors
              await sessions.delete(sessionId);
              clearSessionCookie(res);
              
              return res.status(401).json({
                error: 'Your session has expired. Please login again.',
                requireRelogin: true
              });
            }
            
            // Check for specific contract errors
            if (txError instanceof Error) {
              if (txError.message.includes('ECircleHasActiveMembers')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: Circle has active members',
                  requireRelogin: false
                });
              } else if (txError.message.includes('ECircleHasContributions')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: Circle has received contributions',
                  requireRelogin: false
                });
              } else if (txError.message.includes('ECircleHasSecurity')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: Circle has security deposits',
                  requireRelogin: false
                });
              } else if (txError.message.includes('EOnlyCircleAdmin')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: Only the circle admin can delete this circle',
                  requireRelogin: false
                });
              } else if (txError.message.includes('EWalletCircleMismatch')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: The wallet does not belong to this circle',
                  requireRelogin: false
                });
              } else if (txError.message.includes('EWalletHasBalance') || txError.message.includes(', 47)')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: The wallet has SUI balance. Please withdraw all funds first.',
                  code: 'EWalletHasBalance',
                  walletId: walletId
                });
              } else if (txError.message.includes('EWalletHasStablecoin') || txError.message.includes(', 48)')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: The wallet has stablecoin balance. Please withdraw all funds first.',
                  code: 'EWalletHasStablecoin',
                  walletId: walletId,
                  requireRelogin: false
                });
              } else if (txError.message.includes('dynamic_field') && txError.message.includes('borrow_child_object')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: Unable to find required wallet data. The circle may be in an inconsistent state.',
                  requireRelogin: false,
                  details: 'This is likely due to the wallet ID not matching any dynamic field in the circle object.'
                });
              } else if (txError.message.includes('deleted') || txError.message.includes('invalid input objects')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: The circle has already been deleted or is no longer available.',
                  code: 'OBJECT_ALREADY_DELETED',
                  requireRelogin: false,
                  details: 'The circle object has already been deleted from the blockchain. Please refresh the page to update the UI.'
                });
              }
            }
            
            // For other errors, keep the session but return error with more detail
            return res.status(500).json({ 
              error: txError instanceof Error ? txError.message : 'Failed to delete circle',
              details: txError instanceof Error ? txError.stack : String(txError),
              requireRelogin: false
            });
          }
        } catch (err) {
          // More detailed error logging
          console.error('Circle deletion error in catch block:', err);
          console.error('Error type:', typeof err);
          console.error('Error message:', err instanceof Error ? err.message : String(err));
          console.error('Error stack:', err instanceof Error ? err.stack : 'No stack trace');
          
          // Check for any signature/proof/verification related errors
          if (err instanceof Error && 
              (err.message.toLowerCase().includes('invalid user signature') || 
               err.message.toLowerCase().includes('groth16 proof verify failed') ||
               err.message.toLowerCase().includes('signature is not valid') ||
               err.message.toLowerCase().includes('cryptographic error') ||
               (err as RPCError).code === -32002)) {
            // Clear the session and return 401
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({ 
              error: 'Your session has expired. Please try again from the dashboard.',
              requireRelogin: true
            });
          }
          // Handle other transaction errors
          console.error('Transaction error:', err);
          return res.status(500).json({ 
            error: 'Failed to delete circle. Please try again.',
            details: err instanceof Error ? err.message : 'Unknown error',
            requireRelogin: false
          });
        }

      case 'adminApproveMember':
        try {
          if (!account) {
            return res.status(400).json({ error: 'Account data is required' });
          }

          if (!req.body.circleId || !req.body.memberAddress) {
            return res.status(400).json({ error: 'Circle ID and member address are required' });
          }

          // Validate the session
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            // Just validate the session without storing the result
            await validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }

          // Handle network parameter if provided by frontend
          const requestedNetwork = req.body.network;
          if (requestedNetwork && (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet')) {
            console.log(`Frontend requested network: ${requestedNetwork}, current server network: ${getCurrentNetwork()}`);
          }

          try {
            // Create a transaction for admin_approve_member
            console.log(`Building moveCall for adding member: ${req.body.circleId}, member: ${req.body.memberAddress}`);
            
            try {
              // Temporarily set the network to match the frontend request
              const originalNetwork = getCurrentNetwork();
              let txResult;
              
              try {
                if (requestedNetwork && requestedNetwork !== originalNetwork) {
                  console.log(`Temporarily switching server network from ${originalNetwork} to ${requestedNetwork} for transaction`);
                  setCurrentNetwork(requestedNetwork as NetworkType);
                  // Reinitialize the EnokiZkLoginService with the new network configuration
                  instance.initializeWithNetwork();
                }
                
                // Get the correct package ID for this circle using the current network context
                const circlePackageId = await resolveCirclePackageIdForTransaction({
                  context: 'adminApproveMember',
                  network: getCurrentNetwork(),
                  circleId: req.body.circleId,
                  userAddress: account.userAddr,
                });
                console.log(`Using package ID for circle ${req.body.circleId}: ${circlePackageId} (network: ${getCurrentNetwork()})`);
              
                // Send transaction using zkLogin service
                txResult = await instance.sendTransaction(
                  account,
                  (txb: Transaction) => {
                    txb.setSender(account.userAddr);
                    
                    // Call our implemented admin_approve_member function
                    txb.moveCall({
                      target: `${circlePackageId}::njangi_circles::admin_approve_member`,
                      arguments: [
                        txb.object(req.body.circleId),
                        txb.pure.address(req.body.memberAddress),
                        txb.object("0x6")  // Clock object
                      ]
                    });
                  },
                  { gasBudget: 100000000 } // Higher gas budget for member approval
                );
              } finally {
                // Always restore the original network and reinitialize the service
                if (requestedNetwork && requestedNetwork !== originalNetwork) {
                  console.log(`Restoring server network back to ${originalNetwork}`);
                  setCurrentNetwork(originalNetwork as NetworkType);
                  instance.initializeWithNetwork();
                }
              }
              
              console.log('Admin approve member transaction successful:', txResult);
              return res.status(200).json({
                digest: txResult.digest,
                status: txResult.status,
                gasUsed: txResult.gasUsed
              });
            } catch (txError) {
              console.error('Admin approve member transaction error:', txError);
              console.error('Error type:', typeof txError);
              console.error('Error message:', txError instanceof Error ? txError.message : String(txError));
              console.error('Error stack:', txError instanceof Error ? txError.stack : 'No stack trace');
              
              // Check if the error is related to proof verification
              if (txError instanceof Error && 
                  (txError.message.includes('proof verify failed') ||
                   txError.message.includes('Session expired') ||
                   txError.message.includes('re-authenticate'))) {
                
                // Clear the session for authentication errors
                  await sessions.delete(sessionId);
                clearSessionCookie(res);
                
                return res.status(401).json({
                  error: 'Your session has expired. Please login again.',
                  requireRelogin: true
                });
              }
              
              // Check for specific contract errors
              if (txError instanceof Error) {
                if (txError.message.includes('ENotCircleAdmin')) {
                  return res.status(400).json({ 
                    error: 'Cannot approve: Only the circle admin can approve new members',
                    requireRelogin: false
                  });
                } else if (txError.message.includes('EMemberAlreadyActive')) {
                  return res.status(400).json({ 
                    error: 'Member is already active in this circle',
                    requireRelogin: false
                  });
                } else if (txError.message.includes('ECircleIsFull')) {
                  return res.status(400).json({ 
                    error: 'Cannot approve: Circle has reached maximum member capacity',
                    requireRelogin: false
                  });
                }
              }
              
              // For other errors, keep the session but return error with more detail
              return res.status(500).json({ 
                error: txError instanceof Error ? txError.message : 'Failed to execute transaction',
                details: txError instanceof Error ? txError.stack : String(txError),
                requireRelogin: false
              });
            }
          } catch (error) {
            console.error('Admin approve member error:', error);
            return res.status(500).json({ 
              error: error instanceof Error ? error.message : 'Failed to process admin approve member request',
              requireRelogin: false
            });
          }
        } catch (error) {
          console.error('Admin approve member error:', error);
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to process admin approve member request',
            requireRelogin: false
          });
        }

      case 'adminApproveMembers':
        try {
          if (!account) {
            return res.status(400).json({ error: 'Account data is required' });
          }

          if (!req.body.circleId || !req.body.memberAddresses || !Array.isArray(req.body.memberAddresses)) {
            return res.status(400).json({ error: 'Circle ID and member addresses array are required' });
          }

          // Validate the session
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            // Just validate the session without storing the result
            await validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }

          // Handle network parameter if provided by frontend
          const requestedNetwork = req.body.network;
          if (requestedNetwork && (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet')) {
            console.log(`Frontend requested network: ${requestedNetwork}, current server network: ${getCurrentNetwork()}`);
          }

          try {
            // Create a transaction for admin_approve_members
            console.log(`Building moveCall for adding multiple members to circle: ${req.body.circleId}, member count: ${req.body.memberAddresses.length}`);
            
            try {
              // Temporarily set the network to match the frontend request
              const originalNetwork = getCurrentNetwork();
              let txResult;
              
              try {
                if (requestedNetwork && requestedNetwork !== originalNetwork) {
                  console.log(`Temporarily switching server network from ${originalNetwork} to ${requestedNetwork} for transaction`);
                  setCurrentNetwork(requestedNetwork as NetworkType);
                  // Reinitialize the EnokiZkLoginService with the new network configuration
                  instance.initializeWithNetwork();
                }
                
                // Get the correct package ID for this circle using the current network context
                const circlePackageId = await resolveCirclePackageIdForTransaction({
                  context: 'adminApproveMembers',
                  network: getCurrentNetwork(),
                  circleId: req.body.circleId,
                  userAddress: account.userAddr,
                });
                console.log(`Using package ID for bulk approve in circle ${req.body.circleId}: ${circlePackageId} (network: ${getCurrentNetwork()})`);
                
                // Normalize all addresses
                const normalizedAddresses = req.body.memberAddresses.map((addr: string) => {
                  // Ensure all addresses have 0x prefix and are lowercase
                  return addr.toLowerCase().startsWith('0x') ? addr.toLowerCase() : `0x${addr.toLowerCase()}`;
                });

                // Send transaction using zkLogin service
                txResult = await instance.sendTransaction(
                  account,
                  (txb: Transaction) => {
                    txb.setSender(account.userAddr);
                    
                    // Create a move vector of addresses
                    const addressArgs = normalizedAddresses.map((addr: string) => txb.pure.address(addr));
                    
                    // Call our implemented admin_approve_members function
                    txb.moveCall({
                      target: `${circlePackageId}::njangi_circles::admin_approve_members`,
                      arguments: [
                        txb.object(req.body.circleId),
                        txb.makeMoveVec({ elements: addressArgs, type: 'address' }),
                        txb.object("0x6")  // Clock object
                      ]
                    });
                  },
                  { gasBudget: 150000000 } // Higher gas budget for multiple member approvals
                );
              } finally {
                // Always restore the original network and reinitialize the service
                if (requestedNetwork && requestedNetwork !== originalNetwork) {
                  console.log(`Restoring server network back to ${originalNetwork}`);
                  setCurrentNetwork(originalNetwork as NetworkType);
                  instance.initializeWithNetwork();
                }
              }
              
              console.log('Admin approve multiple members transaction successful:', txResult);
              return res.status(200).json({
                digest: txResult.digest,
                status: txResult.status,
                gasUsed: txResult.gasUsed
              });
            } catch (txError) {
              console.error('Admin approve multiple members transaction error:', txError);
              console.error('Error type:', typeof txError);
              console.error('Error message:', txError instanceof Error ? txError.message : String(txError));
              console.error('Error stack:', txError instanceof Error ? txError.stack : 'No stack trace');
              
              // Check if the error is related to proof verification
              if (txError instanceof Error && 
                  (txError.message.includes('proof verify failed') ||
                   txError.message.includes('Session expired') ||
                   txError.message.includes('re-authenticate'))) {
                
                // Clear the session for authentication errors
                await sessions.delete(sessionId);
                clearSessionCookie(res);
                
                return res.status(401).json({
                  error: 'Your session has expired. Please login again.',
                  requireRelogin: true
                });
              }
              
              // Check for specific contract errors
              if (txError instanceof Error) {
                if (txError.message.includes('ENotCircleAdmin')) {
                  return res.status(400).json({ 
                    error: 'Cannot approve: Only the circle admin can approve new members',
                    requireRelogin: false
                  });
                } else if (txError.message.includes('EMemberAlreadyActive')) {
                  return res.status(400).json({ 
                    error: 'One or more members are already active in this circle',
                    requireRelogin: false
                  });
                } else if (txError.message.includes('ECircleIsFull')) {
                  return res.status(400).json({ 
                    error: 'Cannot approve: Circle has reached maximum member capacity',
                    requireRelogin: false
                  });
                }
              }
              
              // For other errors, keep the session but return error with more detail
              return res.status(500).json({ 
                error: txError instanceof Error ? txError.message : 'Failed to execute transaction',
                details: txError instanceof Error ? txError.stack : String(txError),
                requireRelogin: false
              });
            }
          } catch (error) {
            console.error('Admin approve multiple members error:', error);
            return res.status(500).json({ 
              error: error instanceof Error ? error.message : 'Failed to process bulk member approval request',
              requireRelogin: false
            });
          }
        } catch (error) {
          console.error('Admin approve multiple members error:', error);
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to process bulk member approval request',
            requireRelogin: false
          });
        }

      case 'adminRemoveMember':
        try {
          if (!account) {
            return res.status(400).json({ error: 'Account data is required' });
          }

          if (!req.body.circleId || !req.body.memberAddress || !req.body.walletId) {
            return res.status(400).json({ error: 'Circle ID, member address, and wallet ID are required' });
          }

          // Validate the session
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            await validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }

          // Handle network parameter if provided by frontend
          const requestedNetwork = req.body.network;
          if (requestedNetwork && (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet')) {
            console.log(`Frontend requested network: ${requestedNetwork}, current server network: ${getCurrentNetwork()}`);
          }

          try {
            console.log(`Building moveCall for removing member: ${req.body.memberAddress} from circle: ${req.body.circleId}`);
            
            // Get the correct RPC URL for the requested network
            const networkToUse = requestedNetwork || getCurrentNetwork();
            const suiClient = await createSuiClient(networkToUse);
            console.log(`[adminRemoveMember] Using ${networkToUse} network for object validation`);
            
            // Verify the circle exists on the requested network
            let circleObj;
            try {
              circleObj = await suiClient.getObject({
                id: req.body.circleId,
                options: { showType: true, showContent: true }
              });
              
              if (!circleObj.data) {
                return res.status(400).json({ 
                  error: `Circle not found on ${networkToUse} network. Please ensure you're on the correct network.`,
                  requireRelogin: false
                });
              }
            } catch (error) {
              console.error('Error fetching circle object:', error);
              return res.status(400).json({ 
                error: `Failed to fetch circle on ${networkToUse} network: ${error instanceof Error ? error.message : String(error)}`,
                requireRelogin: false
              });
            }
            
            // Verify the wallet exists on the requested network
            let walletObj;
            try {
              walletObj = await suiClient.getObject({
                id: req.body.walletId,
                options: { showContent: true }
              });
              
              if (!walletObj.data) {
                return res.status(400).json({ 
                  error: `Wallet not found on ${networkToUse} network. Please ensure you're on the correct network.`,
                  requireRelogin: false
                });
              }
            } catch (error) {
              console.error('Error fetching wallet object:', error);
              return res.status(400).json({ 
                error: `Failed to fetch wallet on ${networkToUse} network: ${error instanceof Error ? error.message : String(error)}`,
                requireRelogin: false
              });
            }
            
            // Extract the actual package ID from the circle object type
            const objectType = circleObj.data.type;
            if (!objectType || !objectType.includes('njangi_circles::Circle')) {
              return res.status(400).json({ 
                error: `Object ${req.body.circleId} is not a Circle object. Found type: ${objectType || 'undefined'}`,
                requireRelogin: false
              });
            }
            
            const objectPackageId = objectType.split('::')[0];
            console.log(`[adminRemoveMember] Extracted package ID from circle object: ${objectPackageId}`);
            const packageIdToUse = await resolveCirclePackageIdForTransaction({
              context: 'adminRemoveMember',
              network: networkToUse,
              circleId: req.body.circleId,
              objectPackageId,
              userAddress: account.userAddr,
            });
            console.log(`[adminRemoveMember] Effective package ID for transaction: ${packageIdToUse}`);
            
            // Check if circle is inactive (required for member removal)
            let isPausedAfterCycle = false;
            if (circleObj.data?.content && 'fields' in circleObj.data.content) {
              const fields = circleObj.data.content.fields as Record<string, unknown>;
              if (fields.is_active === true) {
                return res.status(400).json({ 
                  error: 'Cannot remove member: Circle is still active. Please deactivate the circle first.',
                  requireRelogin: false
                });
              }
              isPausedAfterCycle = fields.paused_after_cycle === true;
              console.log(`[adminRemoveMember] Circle is inactive (is_active: ${fields.is_active}), proceeding with member removal`);
            }

            const normalizedMemberAddress = normalizeAddress(req.body.memberAddress);
            const depositContext = await resolveMemberSecurityDepositContext({
              suiClient,
              packageId: packageIdToUse,
              circleId: req.body.circleId,
              walletId: req.body.walletId,
              memberAddress: normalizedMemberAddress,
              circleContent: circleObj.data.content,
              walletContent: walletObj.data?.content,
            });

            console.log('[adminRemoveMember] Member deposit context:', {
              memberAddress: normalizedMemberAddress,
              hasPaidDeposit: depositContext.hasPaidDeposit,
              depositBalance: depositContext.depositBalance.toString(),
              coinKind: depositContext.coinKind,
              isPausedAfterCycle,
            });
            
            try {
              // Temporarily set the network to match the frontend request
              const originalNetwork = getCurrentNetwork();
              let txResult;
              
              try {
                if (requestedNetwork && requestedNetwork !== originalNetwork) {
                  console.log(`Temporarily switching server network from ${originalNetwork} to ${requestedNetwork} for transaction`);
                  setCurrentNetwork(requestedNetwork as NetworkType);
                  // Reinitialize the EnokiZkLoginService with the new network configuration
                  instance.initializeWithNetwork();
                }
                
                // Send transaction using zkLogin service with the extracted package ID
                txResult = await instance.sendTransaction(
                  account,
                  (txb: Transaction) => {
                    txb.setSender(account.userAddr);

                    // Phase 4 cleanup: the prepended admin_payout_security_deposit_*
                    // calls targeted Move functions deleted in Phase 1. The new
                    // `admin_remove_member` returns SUI deposits inline via
                    // `release_sui_to_member`. Stablecoin deposit refunds now
                    // require the member-initiated recovery flow
                    // (src/lib/recovery-execution.ts); surface a warning so ops
                    // don't assume a stablecoin removal silently refunded.
                    if (
                      depositContext.hasPaidDeposit &&
                      depositContext.depositBalance > 0n &&
                      depositContext.coinKind === 'stablecoin'
                    ) {
                      console.warn(
                        '[adminRemoveMember] Stablecoin security-deposit return is not attached to admin_remove_member anymore. ' +
                          'The member must run the recovery liveness flow to receive their refund.',
                        { member: normalizedMemberAddress, balance: depositContext.depositBalance.toString() }
                      );
                    }

                    txb.moveCall({
                      target: `${packageIdToUse}::njangi_circles::admin_remove_member`,
                      arguments: [
                        txb.object(req.body.circleId),
                        txb.pure.address(normalizedMemberAddress),
                        txb.object(req.body.walletId),
                        txb.object(CLOCK_OBJECT_ID)
                      ]
                    });
                  },
                  { gasBudget: 100000000 } // Higher gas budget for member removal
                );
              } finally {
                // Always restore the original network and reinitialize the service
                if (requestedNetwork && requestedNetwork !== originalNetwork) {
                  console.log(`Restoring server network back to ${originalNetwork}`);
                  setCurrentNetwork(originalNetwork as NetworkType);
                  instance.initializeWithNetwork();
                }
              }
              
              console.log('Admin remove member transaction result:', txResult);
              
              // Check if transaction actually succeeded
              if (txResult.status === 'failure') {
                console.error('Admin remove member transaction failed:', txResult.error);
                
                const errorStr = txResult.error || '';
                let errorMessage = mapSecurityDepositErrorMessage(errorStr);
                
                if (errorStr.includes('ENotAdmin') || errorStr.includes(', 1)')) {
                  errorMessage = 'Only the circle admin can remove members';
                } else if (errorStr.includes('EMemberNotFound') || errorStr.includes(', 5)')) {
                  errorMessage = 'Member not found in this circle';
                }
                
                return res.status(400).json({
                  error: errorMessage,
                  digest: txResult.digest,
                  status: txResult.status,
                  details: txResult.error,
                  requireRelogin: false
                });
              }
              
              return res.status(200).json({
                digest: txResult.digest,
                status: txResult.status,
                gasUsed: txResult.gasUsed
              });
            } catch (txError) {
              console.error('Admin remove member transaction error:', txError);
              console.error('Error type:', typeof txError);
              console.error('Error message:', txError instanceof Error ? txError.message : String(txError));
              console.error('Error stack:', txError instanceof Error ? txError.stack : 'No stack trace');
              
              // Check if the error is related to proof verification
              if (txError instanceof Error && 
                  (txError.message.includes('proof verify failed') ||
                   txError.message.includes('Session expired') ||
                   txError.message.includes('re-authenticate'))) {
                
                // Clear the session for authentication errors
                await sessions.delete(sessionId);
                clearSessionCookie(res);
                
                return res.status(401).json({
                  error: 'Your session has expired. Please login again.',
                  requireRelogin: true
                });
              }
              
              // Check for specific contract errors
              if (txError instanceof Error) {
                if (txError.message.includes('ENotAdmin')) {
                  return res.status(400).json({ 
                    error: 'Cannot remove member: Only the circle admin can remove members',
                    requireRelogin: false
                  });
                } else if (txError.message.includes('EMemberNotFound')) {
                  return res.status(400).json({ 
                    error: 'Member not found in this circle',
                    requireRelogin: false
                  });
                } else if (txError.message.includes('ECircleIsActive')) {
                  return res.status(400).json({ 
                    error: 'Cannot remove member: Members can only be removed from inactive circles',
                    requireRelogin: false
                  });
                } else if (txError.message.includes('MoveAbort')) {
                  return res.status(400).json({
                    error: mapSecurityDepositErrorMessage(txError.message, 'Failed to remove member'),
                    requireRelogin: false
                  });
                }
              }
              
              // For other errors, keep the session but return error with more detail
              return res.status(500).json({ 
                error: txError instanceof Error ? txError.message : 'Failed to execute transaction',
                details: txError instanceof Error ? txError.stack : String(txError),
                requireRelogin: false
              });
            }
          } catch (error) {
            console.error('Admin remove member error:', error);
            return res.status(500).json({ 
              error: error instanceof Error ? error.message : 'Failed to process admin remove member request',
              requireRelogin: false
            });
          }
        } catch (error) {
          console.error('Admin remove member error:', error);
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to process admin remove member request',
            requireRelogin: false
          });
        }

      case 'executeStablecoinSwap':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

      // Legacy compatibility route for historical swap automation experiments.
      // This is not part of the active eSui-dollar Ember vault migration flow.
      case 'swapAndDepositCetus':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          // Add circleId to the required parameters
          const { walletId, suiAmount, slippage = 100, circleId, network: requestedNetwork } = req.body; 
          if (!walletId || !suiAmount || !circleId) {
            return res.status(400).json({ error: 'Wallet ID, Circle ID, and SUI amount are required' });
          }

          const originalNetwork = getCurrentNetwork();
          const shouldSwitchNetwork =
            (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet') &&
            requestedNetwork !== originalNetwork;

          if (shouldSwitchNetwork) {
            console.log(
              `Temporarily switching server network from ${originalNetwork} to ${requestedNetwork} for legacy Cetus swap`
            );
            setCurrentNetwork(requestedNetwork as NetworkType);
            aggregatorSDK = null;
            aggregatorSDKNetwork = null;
            instance.initializeWithNetwork();
          }

          try {
            const session = await validateSession(sessionId, 'sendTransaction');
            if (!session.account) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
              return res.status(401).json({ 
                error: 'Invalid session: No account data found. Please authenticate first.'
              });
            }

            const packageIdToUse = await resolveCirclePackageIdForTransaction({
              context: 'swapAndDepositCetus',
              network: getCurrentNetwork(),
              circleId,
              userAddress: session.account.userAddr,
            });
            const packageIdsForLookup = getPackageLookupIdsForCurrentNetwork(packageIdToUse);
            const currentCoinTypes = getCurrentCoinTypes();
            const currentUsdcCoinType = currentCoinTypes.USDC;

          // Validate amount and convert from SUI to MIST (smallest unit, 1 SUI = 10^9 MIST)
          // Handle both string/number inputs and decimal values
          let suiAmountMIST: bigint;
          try {
            // Convert decimal SUI to MIST integer before creating BigInt
            const suiAmountNumber = typeof suiAmount === 'string' ? parseFloat(suiAmount) : suiAmount;
            const mistAmount = Math.floor(suiAmountNumber * 1e9); // Convert to MIST and ensure integer
            suiAmountMIST = BigInt(mistAmount);
            
            console.log(`Converting ${suiAmountNumber} SUI to ${suiAmountMIST} MIST`);
          } catch (e) {
            console.error('Error converting SUI amount to MIST:', e);
            return res.status(400).json({ error: 'Invalid SUI amount format. Please provide a valid number.' });
          }
          
          if (suiAmountMIST <= BigInt(0) || suiAmountMIST > BigInt(1e12)) {
            return res.status(400).json({ error: 'Invalid SUI amount: must be greater than 0 and less than 1,000 SUI' });
          }

          // Ensure slippage is at least the minimum
          const effectiveSlippage = Math.max(slippage, MIN_AGGREGATOR_SLIPPAGE);

          // *** NEW: Check if user has already paid security deposit ***
          const suiClient = await createSuiClient();
          let userDepositPaid = false;
          
          try {
            console.log(`Checking deposit status for user ${session.account.userAddr} in circle ${circleId}`);
            
            // Get the circle object
            const circleObject = await suiClient.getObject({
              id: circleId,
              options: { showContent: true }
            });
            
            if (circleObject.data?.content && 'fields' in circleObject.data.content) {
              const circleFields = circleObject.data.content.fields as {
                members?: { fields?: { id?: { id: string } } } // Check if members table exists
              };
              
              if (circleFields.members?.fields?.id?.id) {
                const membersTableId = circleFields.members.fields.id.id;
                console.log(`Attempting to fetch Member object using key ${session.account.userAddr} from table ${membersTableId}`);
                
                // Get the dynamic field representing the Member object within the Table
                const memberField = await suiClient.getDynamicFieldObject({
                  parentId: membersTableId,
                  name: {
                    type: 'address', // The key type for the members table is address
                    value: session.account.userAddr
                  }
                });
                
                if (memberField.data?.content && 'fields' in memberField.data.content) {
                  const memberFields = memberField.data.content.fields as {
                    value?: { fields?: { deposit_paid?: boolean, [key: string]: unknown } } // Access nested value.fields
                  };
                  
                  if (memberFields.value?.fields?.deposit_paid !== undefined) {
                    userDepositPaid = Boolean(memberFields.value.fields.deposit_paid);
                    console.log(`Deposit status found directly in Member struct: ${userDepositPaid}`);
                  }
                }
              }
            }
            
            // Fallback to checking MemberActivated events if direct fetch fails
            if (!userDepositPaid) {
              for (const packageId of packageIdsForLookup) {
                const memberActivatedEvents = await suiClient.queryEvents({
                  query: { MoveEventType: `${packageId}::njangi_members::MemberActivated` },
                  limit: 50
                });
                
                userDepositPaid = memberActivatedEvents.data.some(event => {
                  const parsed = event.parsedJson as { circle_id?: string; member?: string };
                  return parsed?.circle_id === circleId && parsed?.member === session.account!.userAddr;
                });

                if (userDepositPaid) {
                  break;
                }
              }
              
              if (userDepositPaid) {
                console.log('Deposit status confirmed via MemberActivated event');
              }
            }
            
            // Additional check for CustodyDeposited events with operation_type 3 (security deposit)
            if (!userDepositPaid) {
              for (const packageId of packageIdsForLookup) {
                const custodyEvents = await suiClient.queryEvents({
                  query: { MoveEventType: `${packageId}::njangi_custody::CustodyDeposited` },
                  limit: 50
                });
                
                userDepositPaid = custodyEvents.data.some(e => {
                  const p = e.parsedJson as { circle_id?: string; member?: string; operation_type?: number | string };
                  return p?.circle_id === circleId && 
                         p?.member === session.account!.userAddr && 
                         (p?.operation_type === 3 || p?.operation_type === "3");
                });

                if (userDepositPaid) {
                  break;
                }
              }
              
              if (userDepositPaid) {
                console.log('Deposit status confirmed via CustodyDeposited event');
              }
            }
            
            console.log(`Final user deposit status: ${userDepositPaid ? 'PAID' : 'NOT PAID'}`);
          } catch (error) {
            // REFUSE — do not guess. This flag selects the Move call
            // target below: "not paid" routes the member's swapped USDC
            // into member_deposit_security_deposit instead of
            // contribute_stablecoin. Assuming "not paid" on a failed read
            // therefore takes a member who ALREADY paid their deposit and
            // sends their contribution in as a second one. A read failure
            // must never move money down a different path.
            console.error('Error checking deposit status; refusing to guess:', error);
            return res.status(503).json({
              error: 'DEPOSIT_STATUS_UNAVAILABLE',
              message:
                'We could not confirm your security deposit status just now, so we have not moved any funds. Please try again shortly.',
            });
          }
          // *** END NEW SECTION ***

          console.log(`Creating transaction for SUI to USDC swap using Cetus Aggregator`);
          console.log(`Using suiAmount (MIST): ${suiAmountMIST}`);
          console.log(`Slippage: ${effectiveSlippage} basis points (${effectiveSlippage/100}%)`);

          // Get Cetus Aggregator SDK
          const aggregator = await getAggregatorSDK();
          
          // Get current epoch for zkLogin - use our helper function instead of direct access
          const { epoch } = await getEpochData();
          const currentEpoch = Number(epoch);
          const maxEpoch = currentEpoch + 2; // Allow 2 epochs of validity
          console.log(`Current epoch: ${currentEpoch}, maxEpoch: ${maxEpoch}`);

          // Check actual pool liquidity
          const validPools = await checkPoolLiquidity();
          console.log(`Valid pools found: ${validPools.length > 0 ? validPools.join(', ') : 'None'}`);

          // Execute the transaction
          try {
            // Try multiple USDC coin types if needed
            let routerData = null;
            let successfulCoinType = null;
            
            // First try with the primary USDC type
            const initialRouteParams = {
              from: SUI_COIN_TYPE,
              target: currentUsdcCoinType,
              amount: new BN(suiAmountMIST.toString()),
              byAmountIn: true,
            };
            
            try {
              routerData = await aggregator.findRouters(initialRouteParams);
              
              // Check if we got valid routes
              if (routerData && routerData.routes && routerData.routes.length > 0) {
                successfulCoinType = currentUsdcCoinType;
                console.log(`Found routes using primary USDC coin type: ${currentUsdcCoinType}`);
              } else {
                console.log(`No routes found with primary USDC coin type: ${currentUsdcCoinType}`);
              }
            } catch (primaryError) {
              console.error(`Error finding routes with primary USDC coin type: ${(primaryError as Error).message || 'unknown error'}`);
            }
            
            // If primary didn't work, try alternates
            if (!successfulCoinType) {
              console.log('Trying alternate USDC coin types...');
              
              for (const altCoinType of getAlternateUsdcCoinTypes()) {
                // Skip the one we already tried
                if (altCoinType === currentUsdcCoinType) continue;
                
                try {
                  console.log(`Trying alternate USDC type: ${altCoinType}`);
                  const altRouteParams = {
                    ...initialRouteParams,
                    target: altCoinType
                  };
                  
                  const altRouterData = await aggregator.findRouters(altRouteParams);
                  
                  if (altRouterData && altRouterData.routes && altRouterData.routes.length > 0) {
                    routerData = altRouterData;
                    successfulCoinType = altCoinType;
                    console.log(`Found routes using alternate USDC coin type: ${altCoinType}`);
                    break;
                  } else {
                    console.log(`No routes found with alternate USDC coin type: ${altCoinType}`);
                  }
                } catch (altError) {
                  console.error(`Error finding routes with alternate USDC coin type (${altCoinType}): ${(altError as Error).message || 'unknown error'}`);
                }
              }
            }
            
            // Add more detailed logging
            console.log('Aggregator response received:', {
              hasData: !!routerData,
              amountIn: routerData?.amountIn?.toString() || 'N/A',
              amountOut: routerData?.amountOut?.toString() || 'N/A',
              insufficientLiquidity: routerData?.insufficientLiquidity,
              routesCount: routerData?.routes?.length || 0,
              errorCode: routerData?.error?.code,
              errorMsg: routerData?.error?.msg,
              usingCoinType: successfulCoinType || 'None'
            });
            
            // Check for liquidity issues BEFORE trying to create the transaction
            if (!routerData || !routerData.routes || routerData.routes.length === 0) {
              console.log('No routes found, checking for specific errors...');
              
              // Handle specific error cases
              if (routerData?.insufficientLiquidity) {
                console.log('Aggregator found insufficient liquidity, trying direct pool swap as fallback...');
                
                // Try direct pool swap instead
                try {
                  const targetCoinType = currentUsdcCoinType;
                  
                  // Try each valid pool in the direct pool list
                  let tried = 0;
                  for (const poolId of validPools.length > 0 ? validPools : getDirectPoolAddresses()['USDC']) {
                    tried++;
                    try {
                      console.log(`Attempting direct swap with pool ${poolId} (attempt ${tried}/${validPools.length || getDirectPoolAddresses()['USDC'].length})`);
                      
                      // No longer reducing the swap amount - use the full amount
                      console.log(`Using full swap amount for direct pool: ${Number(suiAmountMIST) / 1e9} SUI`);
                      
                      // Execute a simplified transaction that focuses just on the swap
                      const txResult = await instance.sendTransaction(
                        session.account,
                        (txb: Transaction) => {
                          txb.setSender(session.account!.userAddr);
                          
                          try {
                            console.log(`Attempting simple swap with pool ${poolId}`);
                            
                            // Use the full amount requested by the user
                            console.log(`Using full amount for swap: ${Number(suiAmountMIST) / 1e9} SUI`);
                            
                            // Split coins from gas payment - use array destructuring pattern
                            const [splitCoin] = txb.splitCoins(txb.gas, [
                              txb.pure.u64(suiAmountMIST)
                            ]);
                            
                            // Create a vector with the split coin - this is the key difference
                            const coinVector = txb.makeMoveVec({
                              elements: [splitCoin],
                              type: `0x2::coin::Coin<${SUI_COIN_TYPE}>`
                            });
                            
                            // Use swap_b2a to swap FROM token B (SUI) TO token A (USDC)
                            txb.moveCall({
                              target: `0x4f920e1ef6318cfba77e20a0538a419a5a504c14230169438b99aba485db40a6::pool_script::swap_b2a`,
                              typeArguments: [targetCoinType, SUI_COIN_TYPE],
                              arguments: [
                                txb.object("0x9774e359588ead122af1c7e7f64e14ade261cfeecdb5d0eb4a5b3b4c8ab8bd3e"),
                                txb.object(poolId),
                                coinVector,
                                txb.pure.bool(true), // Set to true for swapping B->A (SUI to USDC)
                                txb.pure.u64(suiAmountMIST),
                                txb.pure.u64(0),
                                txb.pure.u128("79226673515401279992447579055"), // Use the working b2a sqrt_price_limit value
                                txb.object('0x6')
                              ]
                            });
                            
                            // Skip deposit for now - just focusing on the swap
                            console.log("Skipping deposit step for now to focus on swap operation");
                            
                          } catch (moveCallError) {
                            console.error('Error building transaction:', moveCallError);
                            throw moveCallError;
                          }
                        },
                        { gasBudget: 100000000 } // Higher gas budget for swap
                      );
                      
                      console.log('Direct pool swap successful using fallback method:', txResult);
                      return res.status(200).json({ 
                        digest: txResult.digest,
                        status: txResult.status,
                        gasUsed: txResult.gasUsed,
                        method: 'direct_pool_fallback'
                      });
                    } catch (poolError) {
                      if (poolError instanceof Error) {
                        if (poolError.message.includes('notExists') || 
                            poolError.message.includes('object_id') ||
                            poolError.message.includes('invalid input')) {
                          console.error(`Pool ${poolId} doesn't exist or is invalid:`, poolError.message);
                        } else if (poolError.message.includes('insufficient') || 
                                  poolError.message.includes('liquidity')) {
                          console.error(`Pool ${poolId} has insufficient liquidity:`, poolError.message);
                        } else {
                          console.error(`Error trying direct swap with pool ${poolId}:`, poolError.message);
                        }
                      } else {
                        console.error(`Error trying direct swap with pool ${poolId}:`, poolError);
                      }
                      // Continue to next pool if this one fails
                    }
                  }
                  
                  // If we're here, all direct pool attempts failed
                  console.log('All direct pool swap attempts failed');
                  return res.status(400).json({
                    error: 'Insufficient liquidity for both aggregator and direct pool swaps. Try a different amount or try again later.'
                  });
                } catch (fallbackError) {
                  console.error('Error in direct pool fallback:', fallbackError);
                  return res.status(400).json({
                    error: 'Could not complete swap due to liquidity issues. Please try a smaller amount or contact support.'
                  });
                }
              }
            }
            
            // Add back the other checks that were removed
            if (routerData && routerData.error && routerData.error.msg) {
              return res.status(400).json({
                error: `Routing error: ${routerData.error.msg}`
              });
            }
            
            // If amount is very small, suggest increasing it
            if (suiAmountMIST < BigInt(50000000)) { // Less than 0.05 SUI
              return res.status(400).json({
                error: 'Swap amount is too small. Please try a larger amount (at least 0.05 SUI).'
              });
            }
            
            // If we got here and still don't have a valid route, return generic error
            if (!routerData || !routerData.routes || routerData.routes.length === 0) {
              console.log(`Tried all USDC coin types and found no valid routes`);
              return res.status(400).json({
                error: 'No valid swap route found after trying multiple USDC coin types. This may be due to insufficient liquidity.'
              });
            }

            // If we got here, we have a valid route, so proceed with normal flow
            // Use the successful coin type in the deposit call
            const targetCoinType = successfulCoinType || currentUsdcCoinType;
            
            console.log(`Found route with ${routerData.routes.length} paths and amountOut: ${routerData.amountOut.toString()}`);
            
            // Log detailed path information to help with debugging
            routerData.routes.forEach((route, i) => {
              console.log(`Route ${i+1} details:`);
              console.log(`- Input: ${route.amountIn.toString()}, Output: ${route.amountOut.toString()}`);
              route.path.forEach((path, j) => {
                console.log(`  Path ${j+1}: ${path.provider} (${path.from} → ${path.target})`);
                console.log(`  - AmountIn: ${path.amountIn}, AmountOut: ${path.amountOut}, FeeRate: ${path.feeRate}`);
              });
            });
            
            // Calculate minimum amount out with slippage
            const minAmountOut = routerData.amountOut.muln(10000 - effectiveSlippage).divn(10000);
            console.log(`Using minAmountOut: ${minAmountOut.toString()}`);

            // Now we know we have a valid route, so create and execute the transaction
            const txResult = await instance.sendTransaction(
              session.account,
              async (txb: Transaction) => {
                txb.setSender(session.account!.userAddr);
                
                // Split SUI from gas payment
                const [swapCoin] = txb.splitCoins(txb.gas, [
                  txb.pure.u64(suiAmountMIST)
                ]);

                // Create swap transaction with the aggregator
                // THIS RETURNS THE RESULTING STABLECOIN OBJECT
                const stableCoinResult = await aggregator.routerSwap({
                  routers: routerData,
                  inputCoin: swapCoin,
                  slippage: effectiveSlippage,
                  txb
                });
                
                // Now deposit the swapped USDC to the custody wallet
                console.log(`Depositing swapped ${targetCoinType} to circle ${circleId}, wallet ${walletId}`);
                
                // CORRECTED: Choose deposit function based on user deposit status
                if (userDepositPaid) {
                  // User already paid security deposit, use contribute_stablecoin
                  console.log(`User has already paid security deposit, using contribute_stablecoin function`);
                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::contribute_stablecoin`,
                    arguments: [
                      txb.object(circleId),
                      txb.object(walletId),
                      stableCoinResult, // Use the coin from the swap
                      txb.object("0x6") // Clock object
                    ],
                    typeArguments: [targetCoinType] // Use the determined coin type
                  });
                } else {
                  // User has not paid security deposit, use member_deposit_security_deposit
                  console.log(`User has NOT paid security deposit, using member_deposit_security_deposit function`);
                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::member_deposit_security_deposit`,
                    arguments: [
                      txb.object(circleId),
                      txb.object(walletId),
                      stableCoinResult, // Use the coin from the swap
                      txb.object("0x6")  // Clock object
                    ],
                    typeArguments: [targetCoinType] // Use the determined coin type
                  });
                }
              },
              { gasBudget: 100000000 } // Higher gas budget for complex swap + deposit
            );
            
            console.log('Swap and deposit transaction successful:', txResult);
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed,
              userDepositPaid // Include deposit status in response
            });
          } catch (routeError) {
            console.error('Error in swap and deposit transaction:', routeError);
            
            // Distinguish between different types of errors
            if (routeError instanceof Error) {
              // Network errors - these should not trigger re-authentication
              if (routeError.message.includes('Gateway Timeout') || 
                  routeError.message.includes('504') ||
                  routeError.message.includes('network') ||
                  routeError.message.includes('connection')) {
          return res.status(503).json({ 
                  error: 'Network timeout or connection issue. Please try again later.',
                  requireRelogin: false
                });
              }
              
              // Authentication errors - these should trigger re-authentication
              if (routeError.message.includes('proof verify failed') ||
                  routeError.message.includes('Session expired') ||
                  routeError.message.includes('Invalid session')) {
                if (sessionId) {
                  await sessions.delete(sessionId);
                  clearSessionCookie(res);
                }
                return res.status(401).json({
                  error: 'Authentication error: Your session has expired. Please login again.',
                  requireRelogin: true
                });
              }
              
              // DEX-specific errors
              if (routeError.message.includes('Insufficient liquidity') ||
                  routeError.message.includes('No valid swap route') ||
                  routeError.message.includes('slippage') ||
                  routeError.message.includes('price impact')) {
                return res.status(400).json({
                  error: routeError.message,
                  requireRelogin: false
                });
              }
            }
            
            // Generic error handling for anything else
            return res.status(500).json({ 
              error: routeError instanceof Error ? routeError.message : 'Failed to process swap and deposit',
              requireRelogin: false
            });
          }
          } finally {
            if (shouldSwitchNetwork) {
              console.log(`Restoring server network back to ${originalNetwork}`);
              setCurrentNetwork(originalNetwork as NetworkType);
              aggregatorSDK = null;
              aggregatorSDKNetwork = null;
              instance.initializeWithNetwork();
            }
          }
        } catch (err) {
          console.error('Swap and deposit transaction error:', err);
          if (err instanceof Error && 
              (err.message.includes('proof verify failed') ||
               err.message.includes('Session expired') ||
               err.message.includes('proof points') ||
               err.message.includes('zkLogin signature error'))) {
            
            throw new Error('Invalid proof structure: Please re-authenticate');
          }
          
          return res.status(500).json({ 
            error: err instanceof Error ? err.message : 'Failed to process swap and deposit'
          });
        }

      case 'swapAndDepositDeepBook':
        // Legacy compatibility alias only.
        // This does not represent the Ember eSui-dollar migration flow.
        req.body.action = 'swapAndDepositCetus';
        return handler(req, res);

      case 'configureStablecoinSwap':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!req.body.walletId || !req.body.config) {
          return res.status(400).json({ error: 'Missing required parameters: walletId, config' });
        }

        try {
          // Validate configuration params
          const { walletId, config } = req.body;
          
          // Ensure walletId is a string
          if (typeof walletId !== 'string') {
            return res.status(400).json({ error: 'walletId must be a string' });
          }
          
          if (typeof config.enabled !== 'boolean' || 
              !['USDC', 'USDT'].includes(config.targetCoinType) ||
              typeof config.slippageTolerance !== 'number' ||
              typeof config.minimumSwapAmount !== 'number') {
            return res.status(400).json({ 
              error: 'Invalid config parameters. Check types and allowed values.' 
            });
          }

          // Validate session with action context
          const session = await validateSession(sessionId, 'sendTransaction');
          
          if (!session.account) {
            if (sessionId) await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.',
              requireRelogin: true
            });
          }

          // Verify session matches account data
          if (session.account.userAddr !== account.userAddr) {
            if (sessionId) await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Session mismatch: Please refresh your authentication',
              requireRelogin: true
            });
          }

          // Map the simple coin names to their full module paths using network config
          const networkTokens = getCurrentTokens();
          const coinTypeMap: Record<string, string> = {
            'USDC': networkTokens.USDC,
            'USDT': networkTokens.USDT || networkTokens.USDC
          };
          
          // Testnet Cetus configuration 
          // const CETUS_PACKAGE = '0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12';
          // const CETUS_GLOBAL_CONFIG = '0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf7ca';
          
          // Get network-aware pool IDs for the supported coins
          const cetusConfig = getCurrentCetusConfig();
          const poolIds: Record<string, string> = {
            'USDC': cetusConfig.pools.SUI_USDC,
            'USDT': cetusConfig.pools.SUI_USDT || cetusConfig.pools.SUI_USDC
          };
          
          // Get the appropriate pool ID for the selected coin type
          const poolId = poolIds[config.targetCoinType] || poolIds['USDC'];
          
          // Convert minimum amount to MIST (1 SUI = 1e9 MIST)
          const minimumSwapAmount = Math.floor(config.minimumSwapAmount * 1e9);
          const packageIdToUse = await getObjectTransactionPackageId(walletId);
          
          // Execute the transaction with zkLogin - using direct moveCall approach
            const txResult = await instance.sendTransaction(
            session.account,
              (txb) => {
              // Add a simple moveCall directly
                txb.moveCall({
                target: `${packageIdToUse}::njangi_circles::configure_stablecoin_swap`,
                  arguments: [
                    txb.object(walletId),
                  txb.pure.bool(config.enabled),
                  txb.pure.string(coinTypeMap[config.targetCoinType] || coinTypeMap['USDC']),
                  txb.pure.address(getCurrentCetusConfig().packageId),
                  txb.pure.u64(BigInt(config.slippageTolerance)),
                    txb.pure.u64(BigInt(minimumSwapAmount)),
                  txb.pure.address(getCurrentCetusConfig().globalConfig),
                  txb.pure.address(poolId),
                ],
              });
            }
          );
          
          console.log('Stablecoin configuration result:', txResult);
            return res.status(200).json({
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
  } catch (error) {
          console.error('Error configuring stablecoin swap:', error);
          
          // Handle specific error types
          if (error instanceof Error) {
            if (error.message.includes('proof verify failed') ||
                error.message.includes('Session expired') ||
                error.message.includes('re-authenticate')) {
              // Clear the session for authentication errors
              if (sessionId) await sessions.delete(sessionId);
              clearSessionCookie(res);
              
              return res.status(401).json({
                error: 'Your session has expired. Please login again.',
                requireRelogin: true
              });
            }
            
            // Handle transaction-specific errors
            if (error.message.includes('ENotAdmin')) {
              return res.status(403).json({
                error: 'Only the admin can configure stablecoin settings'
              });
            }
            
            if (error.message.includes('EUnsupportedToken')) {
                return res.status(400).json({ 
                error: 'Unsupported stablecoin token type'
                });
              }
            }
            
          // Generic error handling
    return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Unknown error during stablecoin configuration'
          });
        }
        break;

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


      case 'paySecurityDeposit':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        // depositAmount is optional in USDC mode (derived from config), but still used for SUI mode
        if (!req.body.walletId || !req.body.circleId) {
          return res.status(400).json({ error: 'Missing required parameters: walletId, circleId' });
        }

        // Same zeroed-id trap as depositUsdcDirect: fail here rather than
        // letting the all-zero object id reach the RPC.
        if (!isResolvedSuiObjectId(req.body.circleId) || !isResolvedSuiObjectId(req.body.walletId)) {
          return res.status(400).json({
            error: 'Circle details have not finished loading. Refresh the page and retry the deposit.'
          });
        }

        try {
          // Ensure parameters are of the correct type
          const circleId = String(req.body.circleId); // Get circleId
          const walletId = String(req.body.walletId);
          const parsedDepositAmount =
            req.body.depositAmount === undefined || req.body.depositAmount === null
              ? BigInt(0)
              : typeof req.body.depositAmount === 'number'
                ? BigInt(Math.floor(req.body.depositAmount))
                : BigInt(req.body.depositAmount);
          let depositAmount = parsedDepositAmount;

          // Validate session with action context
          const session = await validateSession(sessionId, 'sendTransaction');
          
          if (!session.account) {
            if (sessionId) await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.',
              requireRelogin: true
            });
          }

          // Verify session matches account data
          if (session.account.userAddr !== account.userAddr) {
            if (sessionId) await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Session mismatch: Please refresh your authentication',
              requireRelogin: true
            });
          }

          const currencyResolution = resolveRequestCurrency(req);
          logCurrencySelection('paySecurityDeposit', currencyResolution, {
            circleId,
            walletId,
            userAddr: session.account.userAddr,
          });

          // Handle network parameter if provided by frontend
          const requestedNetwork = req.body.network;
          if (requestedNetwork && (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet')) {
            console.log(`Frontend requested network: ${requestedNetwork}, current server network: ${getCurrentNetwork()}`);
          }

          // Execute the transaction with zkLogin and network switching
          let txResult;
          const originalNetwork = getCurrentNetwork();
          
          try {
            // Temporarily set the network to match the frontend request
            if (requestedNetwork && requestedNetwork !== originalNetwork) {
              console.log(`Temporarily switching server network from ${originalNetwork} to ${requestedNetwork} for transaction`);
              setCurrentNetwork(requestedNetwork as NetworkType);
              // Reinitialize the EnokiZkLoginService with the new network configuration
              instance.initializeWithNetwork();
            }
            
            // Get the effective transaction package ID for this circle on the current network.
            const packageIdToUse = await resolveCirclePackageIdForTransaction({
              context: 'paySecurityDeposit',
              network: getCurrentNetwork(),
              circleId,
              userAddress: session.account!.userAddr,
            });
            console.log(`Using package ID for paySecurityDeposit: ${packageIdToUse} (network: ${getCurrentNetwork()})`);

            const suiClient = await createSuiClient();
            if (currencyResolution.currency === 'USDC') {
              const configFields = await getCircleConfigFields(suiClient, circleId);
              const securityDepositUsdCents = getConfigUsdCents(configFields, ['security_deposit_usd']);

              if (securityDepositUsdCents <= 0) {
                return res.status(400).json({
                  error: 'This circle has no USDC security deposit amount configured. Retry with ?currency=SUI for native SUI deposits.',
                  code: 'EMissingUSDCSecurityDepositConfig',
                });
              }

              const requiredUsdcAmount = usdCentsToMicroUsdc(securityDepositUsdCents);
              const usdcCoins = await getAllCoinsByType(suiClient, session.account.userAddr, USDC_COIN_TYPE);
              const totalUsdc = usdcCoins.reduce((sum, coin) => sum + BigInt(coin.balance), BigInt(0));

              console.log(
                `[paySecurityDeposit][USDC] required=${requiredUsdcAmount} available=${totalUsdc} coinCount=${usdcCoins.length}`
              );

              if (totalUsdc < requiredUsdcAmount) {
                const shortfall = requiredUsdcAmount - totalUsdc;
                return res.status(400).json({
                  error: `Insufficient USDC balance for security deposit. Required ${formatMicroUnits(requiredUsdcAmount)} USDC, available ${formatMicroUnits(totalUsdc)} USDC. Add ${formatMicroUnits(shortfall)} USDC or retry with ?currency=SUI.`,
                  code: 'EInsufficientUsdcBalance',
                  currency: 'USDC',
                  requiredMicroUsdc: requiredUsdcAmount.toString(),
                  availableMicroUsdc: totalUsdc.toString(),
                  shortfallMicroUsdc: shortfall.toString(),
                });
              }

              usdcCoins.sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));

              // Build once; reused by sponsored + self-paid paths. The deposit
              // coin is split from an OWNED USDC object (not txb.gas), so the
              // sponsor's gas coin is never touched for value -> safe to sponsor.
              const buildSecurityDeposit = (txb: Transaction) => {
                txb.setSender(session.account!.userAddr);

                const primaryCoinId = usdcCoins[0].coinObjectId;
                const secondaryCoinIds = usdcCoins.slice(1).map((coin) => coin.coinObjectId);
                if (secondaryCoinIds.length > 0) {
                  txb.mergeCoins(
                    txb.object(primaryCoinId),
                    secondaryCoinIds.map((coinId) => txb.object(coinId))
                  );
                }

                const depositCoin = txb.splitCoins(
                  txb.object(primaryCoinId),
                  [txb.pure.u64(requiredUsdcAmount)]
                );

                txb.moveCall({
                  target: `${packageIdToUse}::njangi_circles::member_deposit_security_deposit`,
                  typeArguments: [USDC_COIN_TYPE],
                  arguments: [
                    txb.object(circleId),
                    txb.object(walletId),
                    depositCoin,
                    txb.object(CLOCK_OBJECT_ID),
                  ],
                });
              };

              // Self-paid only. Sponsorship moved to the client protocol
              // (/api/sponsor/prepare + execute) because the server-side
              // version minted the USER's signature from a server-held key —
              // Enoki supplied only the gas coin, so that path was exactly as
              // custodial as the unsponsored one.
              //
              // This branch is reachable only by pre-Phase-1 sessions, which
              // SERVER_SIGNING_ACTIONS already rejects for anything newer and
              // which expire within a Sui epoch. Those sessions pay their own
              // gas for the short remainder of their life rather than keeping a
              // server-signing path alive for a subsidy.
              try {
                txResult = await instance.sendTransaction(
                  session.account,
                  buildSecurityDeposit,
                  { gasBudget: 120000000 }
                );
              } catch (sponsorErr) {
                console.error(
                  'paySecurityDeposit: transaction failed',
                  sponsorErr,
                );
                txResult = await instance.sendTransaction(
                  session.account,
                  buildSecurityDeposit,
                  { gasBudget: 120000000 }
                );
              }
            } else {
              const configFields = await getCircleConfigFields(suiClient, circleId);
              const configuredSuiDeposit = parsePositiveNumber(configFields?.security_deposit);
              if (configuredSuiDeposit > 0) {
                const expectedDeposit = BigInt(Math.floor(configuredSuiDeposit));
                if (depositAmount === BigInt(0) || depositAmount !== expectedDeposit) {
                  console.log(`Adjusting SUI security deposit from ${depositAmount} to ${expectedDeposit} based on CircleConfig`);
                  depositAmount = expectedDeposit;
                }
              }

              if (depositAmount <= BigInt(0)) {
                return res.status(400).json({
                  error: 'Invalid SUI deposit amount. Provide a positive depositAmount or configure security_deposit in CircleConfig.',
                  code: 'EInvalidSuiDepositAmount',
                });
              }

              txResult = await instance.sendTransaction(
                session.account,
                (txb: Transaction) => {
                  txb.setSender(session.account!.userAddr);
                  const [depositCoin] = txb.splitCoins(txb.gas, [txb.pure.u64(depositAmount)]);

                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::member_deposit_security_deposit`,
                    arguments: [
                      txb.object(circleId),
                      txb.object(walletId),
                      depositCoin,
                      txb.object(CLOCK_OBJECT_ID),
                    ],
                    typeArguments: [SUI_COIN_TYPE],
                  });
                },
                { gasBudget: 100000000 }
              );
            }
          } finally {
            // Always restore the original network and reinitialize the service
            if (requestedNetwork && requestedNetwork !== originalNetwork) {
              console.log(`Restoring server network back to ${originalNetwork}`);
              setCurrentNetwork(originalNetwork as NetworkType);
              instance.initializeWithNetwork();
            }
          }
          
          console.log('Security deposit transaction successful:', txResult);
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (err) {
          console.error('Security deposit error:', err);
          if (err instanceof Error && 
              (err.message.includes('proof verify failed') ||
               err.message.includes('Session expired'))) {
            
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({ 
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          // Add checks for new error codes from the contract
          if (err instanceof Error) {
            if (err.message.includes('EMemberNotFound')) {
              return res.status(400).json({ error: 'Member not found in this circle.' });
            }
            if (err.message.includes('EMemberNotActive')) {
              return res.status(400).json({ error: 'Member is not active in this circle.' });
            }
            if (err.message.includes('EDepositAlreadyPaid')) {
              return res.status(400).json({ error: 'Security deposit has already been paid.' });
            }
            if (err.message.includes('EIncorrectDepositAmount')) {
              return res.status(400).json({ error: 'Incorrect security deposit amount provided. Please try again by refreshing the page.' });
            }
            if (err.message.toLowerCase().includes('insufficient usdc')) {
              return res.status(400).json({
                error: `${err.message} Retry with ?currency=SUI if you want native SUI deposit.`,
                code: 'EInsufficientUsdcBalance',
              });
            }
          }

          return res.status(500).json({ 
            error: err instanceof Error ? err.message : 'Failed to process security deposit'
          });
        }

      case 'depositStablecoin':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        try {
          // Validate circle and wallet IDs
          const { circleId, walletId, coinObjectId, stablecoinType = USDC_COIN_TYPE, depositIsPaid } = req.body; // Read depositIsPaid from request
          
          if (!circleId || !walletId || !coinObjectId) {
            return res.status(400).json({ 
              error: 'Missing required parameters. circleId, walletId, and coinObjectId are required.' 
            });
          }
          
          // Validate session with action context
          const session = await validateSession(sessionId, 'depositStablecoin');
          
          if (!session.account) {
            if (sessionId) await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Authentication error: Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          // Initialize SUI client for checking coin value
          const suiClient = await createSuiClient();
          
          // REMOVED: Backend check for userDepositPaid - rely on frontend status
          console.log(`Frontend reports deposit status: ${depositIsPaid ? 'PAID' : 'NOT PAID'}`);
          
          // Get the coin value to check balance/verify amount
          let coinValue = 0;
          let requiredDepositAmount = 0;
          
          try {
            // Get the coin object to check available balance
            const coinObject = await suiClient.getObject({
              id: coinObjectId,
              options: { showContent: true }
            });
            
            if (coinObject.data?.content && 'fields' in coinObject.data.content) {
              const coinFields = coinObject.data.content.fields as Record<string, unknown>;
              coinValue = Number(coinFields.balance || 0);
            }
            
            // For USDC security deposit, we need to get it from the dynamic fields
            if (stablecoinType.toLowerCase().includes('usdc')) {
	              // First, get the dynamic fields of the circle to find the config
	              console.log('Loading CircleConfig fields for required USDC amount...');
	              const configFields = await getCircleConfigFields(suiClient, circleId);

	              if (configFields) {
	                if (depositIsPaid) {
	                  const contributionAmountUsd = Number(configFields.contribution_amount_usd || 0);
	                  console.log('Found contribution_amount_usd in CircleConfig:', contributionAmountUsd);

	                  if (contributionAmountUsd > 0) {
	                    requiredDepositAmount = Math.floor(contributionAmountUsd * 10000);
	                    console.log('Calculated contribution amount (in microUSDC):', requiredDepositAmount);
	                  }
	                } else {
	                  const securityDepositUsd = Number(configFields.security_deposit_usd || 0);
	                  console.log('Found security_deposit_usd in CircleConfig:', securityDepositUsd);

	                  if (securityDepositUsd > 0) {
	                    requiredDepositAmount = Math.floor(securityDepositUsd * 10000);
	                    console.log('Calculated security deposit amount (in microUSDC):', requiredDepositAmount);
	                  }
	                }
	              }
            } else {
              // For other coins, try to get the regular security_deposit or contribution_amount field from circle
              const circleObject = await suiClient.getObject({
                id: circleId,
                options: { showContent: true }
              });
              
              if (circleObject.data?.content && 'fields' in circleObject.data.content) {
                const circleFields = circleObject.data.content.fields as Record<string, unknown>;
                if (depositIsPaid) {
                  requiredDepositAmount = Number(circleFields.contribution_amount || 0);
                } else {
                  requiredDepositAmount = Number(circleFields.security_deposit || 0);
                }
              }
            }
            
            console.log('Payment info:', {
              requiredDepositAmount,
              coinValue,
              coinType: stablecoinType,
              isSecurityDeposit: !depositIsPaid,
              isContribution: depositIsPaid
            });
            
            // Validate that the coin has sufficient value
            if (requiredDepositAmount > 0 && coinValue < requiredDepositAmount) {
              const shortfall = requiredDepositAmount - coinValue;
              const shortfallUSD = (shortfall / 10000).toFixed(4);
              const requiredUSD = (requiredDepositAmount / 10000).toFixed(4);
              const currentUSD = (coinValue / 10000).toFixed(4);
              
              return res.status(400).json({
                error: `Insufficient USDC balance for deposit. Required: $${requiredUSD} USDC, but coin only has $${currentUSD} USDC. You need $${shortfallUSD} more USDC.`,
                code: 'EInsufficientBalance',
                required: requiredDepositAmount,
                available: coinValue,
                shortfall: shortfall,
                coinId: coinObjectId
              });
            }
          } catch (e) {
            console.error('Error checking circle and coin info:', e);
          }

          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'depositStablecoin',
            network: getCurrentNetwork(),
            circleId,
            userAddress: session.account.userAddr,
          });
          
          // Execute the transaction with coin splitting if needed
          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              
              if (requiredDepositAmount > 0 && coinValue > requiredDepositAmount) {
                // Create a SplitCoins transaction for exact amount if needed
                console.log(`Splitting coin ${coinObjectId} to get exact required amount: ${requiredDepositAmount} microUSDC`);
                
                // Split the coin to get the exact required amount
                const [depositCoin] = txb.splitCoins(
                  txb.object(coinObjectId), 
                  [txb.pure.u64(BigInt(requiredDepositAmount))]
                );
                
                // Execute the deposit with the split coin - choose function based on deposit status from frontend
                if (depositIsPaid) {
                  // User already paid security deposit, this is a contribution
                  console.log('Calling contribute_stablecoin based on frontend status');
                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::contribute_stablecoin`,
                    typeArguments: [stablecoinType],
                    arguments: [
                      txb.object(circleId),
                      txb.object(walletId),
                      depositCoin, // Use the split coin with the exact amount
                      txb.object(CLOCK_OBJECT_ID)
                    ]
                  });
                } else {
                  // User has not paid security deposit yet
                  console.log('Calling member_deposit_security_deposit based on frontend status');
                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::member_deposit_security_deposit`,
                    typeArguments: [stablecoinType],
                    arguments: [
                      txb.object(circleId),
                      txb.object(walletId),
                      depositCoin, // Use the split coin with the exact amount
                      txb.object(CLOCK_OBJECT_ID)
                    ]
                  });
                }
              } else {
                // Just use the coin directly if it matches the required amount
                // or if we couldn't determine the required amount
                if (depositIsPaid) {
                  // User already paid security deposit, this is a contribution
                  console.log('Calling contribute_stablecoin (direct coin) based on frontend status');
                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::contribute_stablecoin`,
                    typeArguments: [stablecoinType],
                    arguments: [
                      txb.object(circleId),
                      txb.object(walletId),
                      txb.object(coinObjectId),
                      txb.object(CLOCK_OBJECT_ID)
                    ]
                  });
                } else {
                  // User has not paid security deposit yet
                  console.log('Calling member_deposit_security_deposit (direct coin) based on frontend status');
                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::member_deposit_security_deposit`,
                    typeArguments: [stablecoinType],
                    arguments: [
                      txb.object(circleId),
                      txb.object(walletId),
                      txb.object(coinObjectId),
                      txb.object(CLOCK_OBJECT_ID)
                    ]
                  });
                }
              }
            },
            { gasBudget: 150000000 } // Increase gas budget
          );
          
          console.log('Deposit transaction successful:', txResult);
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed,
            isSecurityDeposit: !depositIsPaid, // Use frontend status for response
            isContribution: depositIsPaid
          });
        } catch (error) {
          console.error('Error depositing stablecoin:', error);
          
          // Handle authentication errors
          if (error instanceof Error && 
              (error.message.includes('proof verify failed') ||
               error.message.includes('Session expired'))) {
            
            if (sessionId) await sessions.delete(sessionId);
            clearSessionCookie(res);
            
            return res.status(401).json({
              error: 'Authentication error: Your session has expired. Please login again.',
              requireRelogin: true
            });
          }

          // Add checks for new error codes from the contract
          if (error instanceof Error) {
            if (error.message.includes('EMemberNotFound') || error.message.includes('ENotCircleMember') || error.message.includes(', 8)')) {
              return res.status(400).json({ 
                error: 'You are not a member of this circle. Please join the circle first.' 
              });
            }
            
            // More detailed handling for EMemberNotActive error (code 14)
            if (error.message.includes('EMemberNotActive') || error.message.includes(', 14)') || 
                error.message.match(/MoveAbort\(.+, 14\)/)) {
              return res.status(400).json({ 
                error: 'Your membership is not active in this circle. Please contact the circle admin to activate your membership before making a deposit.' 
              });
            }
            
            if (error.message.includes('EDepositAlreadyPaid') || error.message.includes(', 21)')) {
              return res.status(400).json({ 
                error: 'You have already paid the security deposit for this circle. Please try making a regular contribution instead.' 
              });
            }
            
            if (error.message.includes('EIncorrectDepositAmount') || error.message.includes(', 2)')) {
              // Since requiredDepositAmount may not be in this scope, provide a generic message
              return res.status(400).json({ 
                error: 'The deposit amount does not match the required amount for this circle. For USDC deposits, this should be the exact USD value in micro-units (20 cents = 200,000 microUSDC).' 
              });
            }
            
            if (error.message.includes('ECircleNotActive') || error.message.includes(', 54)')) {
              return res.status(400).json({ 
                error: 'The circle is not active yet. Please wait for the admin to activate the circle before making contributions.' 
              });
            }
          }
          
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to deposit stablecoin'
          });
        }

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

      case 'toggleAutoSwap': {
        try {
          // Get circle ID and enabled state from the request body
          const { circleId, enabled, account } = req.body;
          
          if (!circleId) {
            return res.status(400).json({
              error: 'Missing circle ID'
            });
          }
          
          if (!account) {
            return res.status(400).json({
              error: 'Account data is required'
            });
          }
          
          // Validate the session
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            // Just validate the session without storing the result
            await validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }
          
          console.log(`Toggling auto-swap to ${enabled ? 'enabled' : 'disabled'} for circle: ${circleId}`);
          
          try {
            const packageIdToUse = await resolveCirclePackageIdForTransaction({
              context: 'toggleAutoSwap',
              network: getCurrentNetwork(),
              circleId,
              userAddress: account.userAddr,
            });

            // Execute the transaction with zkLogin
            const txResult = await instance.sendTransaction(
              account,
              (txb: Transaction) => {
                console.log(`Building moveCall for toggle_auto_swap on circle: ${circleId}, enabled: ${enabled}`);
                
                // Toggle auto-swap call
                txb.moveCall({
                  target: `${packageIdToUse}::njangi_circles::toggle_auto_swap`,
                  arguments: [
                    txb.object(circleId),
                    txb.pure.bool(enabled),
                    txb.object(CLOCK_OBJECT_ID),
                  ]
                });
              }
            );
            
            console.log('Auto-swap toggle transaction successful:', txResult);
            return res.status(200).json({ 
              success: true,
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
          } catch (txError) {
            console.error('Auto-swap toggle transaction error:', txError);
            
            // Check if the error is related to proof verification
            if (txError instanceof Error && 
                (txError.message.includes('proof verify failed') ||
                 txError.message.includes('Session expired') ||
                 txError.message.includes('re-authenticate'))) {
              
              // Clear the session for authentication errors
              if (sessionId) {
                await sessions.delete(sessionId);
                clearSessionCookie(res);
              }
              
              return res.status(401).json({
                error: 'Your session has expired. Please login again.',
                requireRelogin: true
              });
            }
            
            // Check for specific contract errors
            if (txError instanceof Error) {
              if (txError.message.includes('ENotAdmin') || txError.message.includes(', 7)')) {
                return res.status(400).json({ 
                  error: 'Cannot change token mode: Only the circle admin can modify this setting',
                  requireRelogin: false
                });
              }

              if (
                (txError.message.includes('MoveAbort') && txError.message.includes(', 58)')) ||
                txError.message.includes('ECircleIsActive') ||
                txError.message.includes(', 55)')
              ) {
                return res.status(400).json({
                  error: 'Cannot change token mode during an active cycle',
                  details: 'Token mode is locked until the current cycle is completed and payouts are done.',
                  requireRelogin: false
                });
              }
            }
            
            // For other errors, keep the session but return error
            return res.status(500).json({ 
              error: txError instanceof Error ? txError.message : 'Failed to toggle auto-swap',
              details: txError instanceof Error ? txError.stack : String(txError),
              requireRelogin: false
            });
          }
        } catch (error) {
          console.error('Auto-swap toggle error:', error);
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to toggle auto-swap setting',
            requireRelogin: false
          });
        }
      }

      case 'contributeFromCustody': {
        // Handle network parameter if provided by frontend
        const requestedNetwork = req.body.network;
        if (requestedNetwork && (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet')) {
          console.log(`[contributeFromCustody] Frontend requested network: ${requestedNetwork}, current server network: ${getCurrentNetwork()}`);
        }

        try {
          // Extract parameters from request body
          const { circleId, walletId, account } = req.body;
          
          if (!account) {
            return res.status(400).json({ error: 'Account data is required' });
          }

          if (!circleId || !walletId) {
            return res.status(400).json({ error: 'Circle ID and wallet ID are required' });
          }

          // Ensure sessionId is defined before using it
          if (!sessionId) {
            return res.status(401).json({ 
              error: 'No session found. Please authenticate first.',
              requireRelogin: true
            });
          }

          // Now that we know sessionId is defined, we can safely use it
          const session = await validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.'
            });
          }

          const currencyResolution = resolveRequestCurrency(req);
          logCurrencySelection('contributeFromCustody', currencyResolution, {
            circleId,
            walletId,
            userAddr: session.account.userAddr,
          });

          console.log(
            `Creating ${currencyResolution.currency} contribution transaction for circle ${circleId}, wallet ${walletId}`
          );
          
          // Handle network switching like other endpoints
          const originalNetwork = getCurrentNetwork();
          let txResult;
          
          try {
            // Temporarily set the network to match the frontend request
            if (requestedNetwork && requestedNetwork !== originalNetwork) {
              console.log(`[contributeFromCustody] Temporarily switching server network from ${originalNetwork} to ${requestedNetwork}`);
              setCurrentNetwork(requestedNetwork as NetworkType);
              // Reinitialize the EnokiZkLoginService with the new network configuration
              instance.initializeWithNetwork();
            }
            
            // Get the effective transaction package ID for this circle on the current network.
            const packageIdToUse = await resolveCirclePackageIdForTransaction({
              context: 'contributeFromCustody',
              network: getCurrentNetwork(),
              circleId,
              userAddress: session.account.userAddr,
            });
            console.log(`[contributeFromCustody] Using package ID: ${packageIdToUse} (network: ${getCurrentNetwork()})`);

            const client = await createSuiClient();
            if (currencyResolution.currency === 'USDC') {
              const configFields = await getCircleConfigFields(client, String(circleId));
              const contributionUsdCents = getConfigUsdCents(configFields, [
                'contribution_amount_usd',
                'contribution_amount_local',
              ]);

              if (contributionUsdCents <= 0) {
                return res.status(400).json({
                  error: 'This circle has no USDC contribution amount configured. Retry with ?currency=SUI for native SUI contribution.',
                  code: 'EMissingUSDCContributionConfig',
                });
              }

              const requiredUsdcAmount = usdCentsToMicroUsdc(contributionUsdCents);
              const usdcCoins = await getAllCoinsByType(client, session.account.userAddr, USDC_COIN_TYPE);
              const totalUsdc = usdcCoins.reduce((sum, coin) => sum + BigInt(coin.balance), BigInt(0));

              console.log(
                `[contributeFromCustody][USDC] required=${requiredUsdcAmount} available=${totalUsdc} coinCount=${usdcCoins.length}`
              );

              if (totalUsdc < requiredUsdcAmount) {
                const shortfall = requiredUsdcAmount - totalUsdc;
                return res.status(400).json({
                  error: `Insufficient USDC balance for contribution. Required ${formatMicroUnits(requiredUsdcAmount)} USDC, available ${formatMicroUnits(totalUsdc)} USDC. Add ${formatMicroUnits(shortfall)} USDC or retry with ?currency=SUI.`,
                  code: 'EInsufficientUsdcBalance',
                  currency: 'USDC',
                  requiredMicroUsdc: requiredUsdcAmount.toString(),
                  availableMicroUsdc: totalUsdc.toString(),
                  shortfallMicroUsdc: shortfall.toString(),
                });
              }

              usdcCoins.sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));

              txResult = await instance.sendTransaction(
                session.account,
                (txb: Transaction) => {
                  txb.setSender(session.account!.userAddr);

                  const primaryCoinId = usdcCoins[0].coinObjectId;
                  const secondaryCoinIds = usdcCoins.slice(1).map((coin) => coin.coinObjectId);
                  if (secondaryCoinIds.length > 0) {
                    txb.mergeCoins(
                      txb.object(primaryCoinId),
                      secondaryCoinIds.map((coinId) => txb.object(coinId))
                    );
                  }

                  const contributionCoin = txb.splitCoins(
                    txb.object(primaryCoinId),
                    [txb.pure.u64(requiredUsdcAmount)]
                  );

                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::contribute_stablecoin`,
                    typeArguments: [USDC_COIN_TYPE],
                    arguments: [
                      txb.object(circleId as string),
                      txb.object(walletId as string),
                      contributionCoin,
                      txb.object(CLOCK_OBJECT_ID),
                    ],
                  });
                },
                { gasBudget: 120000000 }
              );
            } else {
              // Keep existing SUI fallback path for explicit ?currency=SUI or useUSDC=false
              let contributionAmount = 0;
              try {
                const configFields = await getCircleConfigFields(client, String(circleId));
                contributionAmount = parsePositiveNumber(configFields?.contribution_amount);

              if (contributionAmount === 0) {
                const circleObject = await client.getObject({
                  id: circleId as string,
                  options: { showContent: true }
                });
                
                if (circleObject.data?.content && 'fields' in circleObject.data.content) {
                  const circleFields = circleObject.data.content.fields as Record<string, unknown>;
                    contributionAmount = parsePositiveNumber(circleFields.contribution_amount);
                  }
                }
              } catch (amountError) {
                console.error('[contributeFromCustody][SUI] Failed to resolve contribution amount from chain:', amountError);
              }

          if (contributionAmount === 0) {
                // REFUSE — do not invent an amount. The old fallback
                // submitted a hardcoded 0.05 SUI as the member's cycle
                // contribution whenever the circle read failed, which is a
                // fabricated money figure moved on the member's behalf.
                // The circle is the only authority on what a share costs.
                console.error('[contributeFromCustody][SUI] Contribution amount unresolved; refusing to guess');
                return res.status(503).json({
                  error: 'CONTRIBUTION_AMOUNT_UNAVAILABLE',
                  message:
                    'We could not read this circle\'s contribution amount just now, so nothing was sent. Please try again shortly.',
                });
          }
          
              txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              
              const contributionCoin = txb.splitCoins(txb.gas, [txb.pure.u64(BigInt(contributionAmount))]);
              
              txb.moveCall({
                target: `${packageIdToUse}::njangi_payments::contribute`,
                arguments: [
                  txb.object(circleId as string),
                  txb.object(walletId as string),
                  contributionCoin,
                      txb.object(CLOCK_OBJECT_ID)
                ]
              });
            },
            { gasBudget: 50000000 }
          );
            }
          } finally {
            // Always restore the original network and reinitialize the service
            if (requestedNetwork && requestedNetwork !== originalNetwork) {
              console.log(`[contributeFromCustody] Restoring server network back to ${originalNetwork}`);
              setCurrentNetwork(originalNetwork as NetworkType);
              instance.initializeWithNetwork();
            }
          }
          
          console.log('Contribution transaction successful:', txResult);
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (err) {
          console.error('Contribution error:', err);
          if (err instanceof Error && 
              (err.message.includes('proof verify failed') ||
               err.message.includes('Session expired'))) {
            
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({ 
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }

          if (err instanceof Error && err.message.toLowerCase().includes('insufficient usdc')) {
            return res.status(400).json({
              error: `${err.message} Retry with ?currency=SUI if you want native SUI contribution.`,
              code: 'EInsufficientUsdcBalance',
            });
          }
          
          return res.status(500).json({ 
            error: err instanceof Error ? err.message : 'Failed to process contribution'
          });
        }
        }

      case 'executeSwapOnly':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        try {
          const { suiAmount, minAmountOut, slippage = 0.5 } = req.body;
          if (!suiAmount) {
            return res.status(400).json({ error: 'SUI amount is required' });
          }

          if (!sessionId) {
            return res.status(401).json({ error: 'No session found. Please authenticate first.' });
          }

          // Validate session
          const session = await validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.'
            });
          }

          console.log(`Creating SUI to USDC swap-only transaction for amount: ${suiAmount}`);
          
          // Use the full amount for the swap
          const suiAmountMIST = typeof suiAmount === 'string' ? 
            BigInt(Math.floor(parseFloat(suiAmount) * 1e9)) : 
            BigInt(Math.floor(suiAmount * 1e9));
            
          console.log(`Using amount for swap: ${Number(suiAmountMIST) / 1e9} SUI`);
          
          // Dynamic slippage approach based on amount size
          // Use more careful slippage for larger amounts, more flexible for smaller amounts
          const effectiveSlippage = Number(slippage);
          const amountInSUI = Number(suiAmountMIST) / 1e9;
          let adaptiveBuffer = 0.05; // Default 5% buffer
          
          // For very small transactions (< 0.1 SUI), allow more buffer to ensure success
          if (amountInSUI < 0.1) {
            adaptiveBuffer = 0.10; // 10% buffer for tiny amounts
          } 
          // For medium transactions around 0.16-0.2 SUI (common security deposit range), be most aggressive
          else if (amountInSUI >= 0.15 && amountInSUI <= 0.2) {
            adaptiveBuffer = 0.25; // 25% buffer for this problematic range
            console.log(`Using extra aggressive buffer (25%) for problematic amount range around 0.16 SUI`);
          }
          // For large transactions (> 1 SUI), be more conservative
          else if (amountInSUI > 1) {
            adaptiveBuffer = 0.03; // 3% buffer for large amounts
          }
          
          // Calculate minAmountOut with adaptive buffer
          // Base calculation on expected rate of ~2.5 USDC per SUI
          const expectedRate = 2.5; // USDC per SUI (approximate market rate)
          const expectedOutput = amountInSUI * expectedRate;
          const calculatedMinAmountOut = Math.floor(expectedOutput * 1e6 * (1 - effectiveSlippage/100));
          
          // Apply adaptive buffer to ensure transaction success
          const effectiveMinAmountOut = minAmountOut ? 
            Math.floor(Number(minAmountOut) * (1 - adaptiveBuffer)) : 
            Math.floor(calculatedMinAmountOut * (1 - adaptiveBuffer));
          
          // Log detailed price information
          console.log(`Expected price: ~${expectedRate} USDC per SUI`);
          console.log(`Expected output: ~${expectedOutput.toFixed(6)} USDC`);
          console.log(`User slippage setting: ${effectiveSlippage}%`);
          console.log(`Adaptive buffer: ${(adaptiveBuffer * 100).toFixed(1)}% based on amount size`);
          console.log(`Min acceptable output: ${(effectiveMinAmountOut/1e6).toFixed(6)} USDC (${((1-(effectiveMinAmountOut/1e6)/expectedOutput)*100).toFixed(2)}% max total slippage)`);

          // Execute only the swap transaction
          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              
              try {
                console.log(`Attempting swap with amount: ${Number(suiAmountMIST) / 1e9} SUI`);
                
                // Split coins from gas payment - use array destructuring pattern
                const [splitCoin] = txb.splitCoins(txb.gas, [
                  txb.pure.u64(suiAmountMIST)
                ]);
                
                // Create a vector with the split coin
                const coinVector = txb.makeMoveVec({
                  elements: [splitCoin],
                  type: `0x2::coin::Coin<${SUI_COIN_TYPE}>`
                });

                // Target stablecoin type - should be USDC
                const targetCoinType = USDC_COIN_TYPE;
                const poolId = 'b01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40';

                // Use optimized price limit based on transaction size and amount
                // For the problematic amount range around 0.16 SUI, use the value that worked previously
                const sqrtPriceLimit = (amountInSUI >= 0.15 && amountInSUI <= 0.2) ? 
                  "79226673515401279992447579000" : // More flexible for problematic range
                  amountInSUI < 0.1 ? 
                    "79226673515401279992447579000" : // Slightly more flexible for small amounts
                    "79226673515401279992447579055"; // Standard for regular amounts
                
                // Use swap_b2a to swap FROM token B (SUI) TO token A (USDC)
                txb.moveCall({
                  target: `0x4f920e1ef6318cfba77e20a0538a419a5a504c14230169438b99aba485db40a6::pool_script::swap_b2a`,
                  typeArguments: [targetCoinType, SUI_COIN_TYPE],
                  arguments: [
                    txb.object("0x9774e359588ead122af1c7e7f64e14ade261cfeecdb5d0eb4a5b3b4c8ab8bd3e"),
                    txb.object(poolId),
                    coinVector,
                    txb.pure.bool(true), // Set to true for swapping B->A (SUI to USDC)
                    txb.pure.u64(suiAmountMIST),
                    txb.pure.u64(effectiveMinAmountOut),
                    txb.pure.u128(sqrtPriceLimit),
                    txb.object('0x6')
                  ]
                });
                
              } catch (moveCallError) {
                console.error('Error building swap transaction:', moveCallError);
                throw moveCallError;
              }
            },
            { gasBudget: 100000000 } // Higher gas budget for swap
          );
          
          console.log('Swap transaction executed:', {
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });

          // Check if transaction failed
          if (txResult.status === 'failure') {
            console.error('Swap transaction failed with status: failure');
            
            // Extract error information from the transaction result
            let errorMessage = 'Swap transaction failed';
            let slippageError = false;
            let recommendedSlippage = Math.min(50, Math.ceil(effectiveSlippage * 2));
            
            // Check for specific error patterns in the transaction result
            if (txResult.error) {
              console.error('Transaction error details:', txResult.error);
              
              // Check for slippage-related errors
              if (txResult.error.includes('MoveAbort') && 
                  (txResult.error.includes('1) in command 2') || 
                   txResult.error.includes('pool_script'))) {
                slippageError = true;
                errorMessage = 'Swap failed due to price movement. Try increasing slippage tolerance.';
                
                // Calculate recommended slippage based on current market conditions
                if (effectiveSlippage < 10) {
                  recommendedSlippage = 15;
                } else if (effectiveSlippage < 20) {
                  recommendedSlippage = 25;
                } else {
                  recommendedSlippage = Math.min(50, effectiveSlippage + 10);
                }
              } else if (txResult.error.includes('insufficient')) {
                errorMessage = 'Insufficient balance for this swap';
              } else if (txResult.error.includes('pool')) {
                errorMessage = 'Liquidity pool error. Please try again later.';
              }
            }
            
            return res.status(400).json({
              error: errorMessage,
              isSlippageError: slippageError,
              recommendedSlippage: recommendedSlippage,
              currentSlippage: effectiveSlippage,
              transactionFailed: true,
              digest: txResult.digest,
              gasUsed: txResult.gasUsed,
              details: txResult.error || 'Transaction execution failed'
            });
          }
          
          // Only proceed with coin extraction if transaction was successful
          let createdCoinId = null;
          
          // Find the created coin object ID from transaction effects
          // Use optional chaining and type checking instead of type assertion
          if (txResult && typeof txResult === 'object' && 'effects' in txResult) {
            const effects = txResult.effects as {
              created?: Array<{
                reference?: { objectId?: string };
                owner?: { AddressOwner?: string };
                objectType?: string;
              }>
            };
            
            if (effects.created && Array.isArray(effects.created) && effects.created.length > 0) {
              // First log all created objects for debugging
              console.log('Created objects in transaction:', 
                effects.created.map(obj => ({
                  id: obj.reference?.objectId,
                  type: obj.objectType,
                  owner: obj.owner?.AddressOwner
                }))
              );
              
              // Improved detection for USDC coins with multiple patterns
              const usdcPatterns = [
                new RegExp(USDC_COIN_TYPE.replace(/[:]/g, '\\:')),  // Exact match with escaping
                /Coin<.*usdc::USDC>/i,
                /Coin<.*USDC>/i,
                /0x[a-f0-9]+::usdc::USDC/i,
                /usdc::USDC/i,
                /coin::Coin<.*usdc::USDC>/i
              ];
              
              // Check for all coins owned by the user first
              const userOwnedCoins = effects.created.filter(created => 
                created.reference?.objectId && 
                created.owner?.AddressOwner === (session.account?.userAddr || '') &&
                created.objectType && 
                created.objectType.includes('Coin')
              );
              
              console.log(`Found ${userOwnedCoins.length} coins owned by user:`, 
                userOwnedCoins.map(coin => ({
                  id: coin.reference?.objectId,
                  type: coin.objectType
                }))
              );
              
              // Direct match using exact USDC coin type
              for (const created of userOwnedCoins) {
                if (created.objectType && created.objectType.includes(USDC_COIN_TYPE)) {
                  createdCoinId = created.reference?.objectId;
                  console.log(`Found exact match for USDC coin: ${createdCoinId}`);
                  break;
                }
              }
              
              // If no direct match, try pattern matching
              if (!createdCoinId) {
                for (const created of userOwnedCoins) {
                  if (created.objectType) {
                    // Check if this is a USDC coin by looking at the objectType using any of our patterns
                    for (const pattern of usdcPatterns) {
                      if (pattern.test(created.objectType)) {
                        createdCoinId = created.reference?.objectId;
                        console.log(`Found USDC coin ID with pattern ${pattern}: ${createdCoinId}`);
                        break;
                      }
                    }
                    if (createdCoinId) break;
                  }
                }
              }
              
              // If still no match, check for non-SUI coins as a fallback
              if (!createdCoinId && userOwnedCoins.length > 0) {
                for (const created of userOwnedCoins) {
                  // If it's a coin but NOT a SUI coin, it's likely our USDC
                  if (created.objectType && 
                      !created.objectType.includes('sui::SUI') && 
                      created.objectType.includes('Coin')) {
                    createdCoinId = created.reference?.objectId;
                    console.log('Found non-SUI coin, assuming USDC:', createdCoinId);
                    break;
                  }
                }
              }
              
              // Last resort - just use the first coin owned by the user if there's only one
              if (!createdCoinId && userOwnedCoins.length === 1) {
                createdCoinId = userOwnedCoins[0].reference?.objectId;
                console.log('Fallback: Using only created coin as USDC:', createdCoinId);
              }
            }
          }
          
          // If we still don't have a coin ID, also check mutated objects
          if (!createdCoinId && txResult && typeof txResult === 'object' && 'effects' in txResult) {
            try {
              const effects = txResult.effects as {
                mutated?: Array<{
                  reference?: { objectId?: string };
                  owner?: { AddressOwner?: string };
                  objectType?: string;
                }>
              };
              
              if (effects.mutated && Array.isArray(effects.mutated)) {
                console.log('Checking mutated objects for USDC coin...');
                const userMutatedCoins = effects.mutated.filter(mutated => 
                  mutated.reference?.objectId && 
                  mutated.owner?.AddressOwner === (session.account?.userAddr || '') &&
                  mutated.objectType && 
                  mutated.objectType.includes('Coin') &&
                  !mutated.objectType.includes('sui::SUI')
                );
                
                console.log(`Found ${userMutatedCoins.length} mutated non-SUI coins owned by user`);
                
                // Try to find USDC in mutated coins
                for (const mutated of userMutatedCoins) {
                  if (mutated.objectType && 
                      (mutated.objectType.includes('usdc') || 
                       mutated.objectType.includes('USDC') ||
                       mutated.objectType.includes(USDC_COIN_TYPE))) {
                    createdCoinId = mutated.reference?.objectId;
                    console.log('Found mutated USDC coin ID:', createdCoinId);
                    break;
                  }
                }
                
                // If still not found but we have only one non-SUI coin, use it
                if (!createdCoinId && userMutatedCoins.length === 1) {
                  createdCoinId = userMutatedCoins[0].reference?.objectId;
                  console.log('Using only mutated non-SUI coin as USDC:', createdCoinId);
                }
              }
            } catch (extractionError) {
              console.error('Error extracting from mutated objects:', extractionError);
            }
          }
          
          // If we still don't have a coin ID, try querying the blockchain
          if (!createdCoinId && session.account) {
            try {
              console.log('Attempting to query blockchain for USDC coins...');
              // We'll make this request conditionally to avoid unnecessary API calls
              const suiClient = await createSuiClient();
              
              // Look for USDC coins owned by the user
              const userCoins = await suiClient.getCoins({
                owner: session.account.userAddr,
                coinType: USDC_COIN_TYPE
              });
              
              if (userCoins.data && userCoins.data.length > 0) {
                // Sort by balance (descending) to get the most recently received coin
                userCoins.data.sort((a, b) => {
                  const diff = BigInt(b.balance) - BigInt(a.balance);
                  return diff > BigInt(0) ? 1 : diff < BigInt(0) ? -1 : 0;
                });
                
                createdCoinId = userCoins.data[0].coinObjectId;
                console.log('Found USDC coin by querying blockchain:', createdCoinId);
              } else {
                console.log('No USDC coins found for user on blockchain');
              }
            } catch (queryError) {
              console.error('Error querying blockchain for USDC coins:', queryError);
            }
          }
          
          // If we still don't have a coin ID, log an error but don't fail completely
          if (!createdCoinId) {
            console.error('Failed to extract created USDC coin ID from transaction result');
            
            // Include error info in the response but return success status
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed,
              error: 'Could not identify the swapped USDC coin object',
              // Still return transaction response for debugging
              transactionResponse: txResult 
            });
          } else {
            console.log('Successfully extracted USDC coin ID:', createdCoinId);
          }
          
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed,
            createdCoinId: createdCoinId
          });
        } catch (error) {
          console.error('Error executing swap-only transaction:', error);
          
          // Check if it's an authentication error
          if (error instanceof Error && 
              (error.message.includes('proof verify failed') ||
               error.message.includes('Session expired') ||
               error.message.includes('re-authenticate'))) {
            
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({ 
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          // Check for slippage-related errors in the error message
          let slippageError = false;
          let recommendedSlippage = 15; // Default recommendation
          
          if (error instanceof Error) {
            const errorMessage = error.message.toLowerCase();
            if (errorMessage.includes('slippage') || 
                errorMessage.includes('price') || 
                errorMessage.includes('moveabort') ||
                errorMessage.includes('pool_script')) {
              slippageError = true;
              recommendedSlippage = Math.min(50, Math.ceil((Number(req.body.slippage) || 5) * 2));
            }
          }
          
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to execute swap',
            details: error instanceof Error ? error.stack : String(error),
            isSlippageError: slippageError,
            recommendedSlippage: recommendedSlippage,
            requireRelogin: false
          });
        }
        break;

      case 'activateCircle': {
        // Handle network parameter if provided by frontend
        const requestedNetwork = req.body.network;
        if (requestedNetwork && (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet')) {
          console.log(`Frontend requested network: ${requestedNetwork}, current server network: ${getCurrentNetwork()}`);
        }

        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          // Validate the circleId from the request
          const circleId = req.body.circleId;
          if (!circleId) {
            return res.status(400).json({ error: 'Circle ID is required' });
          }

          // Validate session with action context
          const session = await validateSession(sessionId, 'sendTransaction');
          
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.'
            });
          }

          // Verify session matches account data
          if (session.account.userAddr !== account.userAddr) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Session mismatch: Please refresh your authentication'
            });
          }

          console.log(`Activating circle ${circleId} on network: ${requestedNetwork || getCurrentNetwork()}`);

          // Handle network switching like other endpoints
          const originalNetwork = getCurrentNetwork();
          let txResult;
          
          try {
            // Temporarily set the network to match the frontend request
            if (requestedNetwork && requestedNetwork !== originalNetwork) {
              console.log(`Temporarily switching server network from ${originalNetwork} to ${requestedNetwork} for activateCircle`);
              setCurrentNetwork(requestedNetwork as NetworkType);
              // Reinitialize the EnokiZkLoginService with the new network configuration
              instance.initializeWithNetwork();
            }
            
            // Get the correct package ID for this circle using the current network context
            const packageIdToUse = await resolveCirclePackageIdForTransaction({
              context: 'activateCircle',
              network: getCurrentNetwork(),
              circleId,
              userAddress: session.account.userAddr,
            });
            console.log(`Using package ID for activateCircle: ${packageIdToUse} (network: ${getCurrentNetwork()})`);

          // Execute the activate circle transaction using ZkLoginService's sendTransaction method
            txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.moveCall({
                target: `${packageIdToUse}::njangi_circles::activate_circle`,
                arguments: [
                  txb.object(circleId),
                  txb.object(CLOCK_OBJECT_ID),
                ],
              });
            }
          );
          } finally {
            // Always restore the original network and reinitialize the service
            if (requestedNetwork && requestedNetwork !== originalNetwork) {
              console.log(`Restoring server network back to ${originalNetwork}`);
              setCurrentNetwork(originalNetwork as NetworkType);
              instance.initializeWithNetwork();
            }
          }

          return res.status(200).json({
            status: 'success',
            digest: txResult.digest,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Error activating circle:', error);
          
          // Handle authentication errors
          if (error instanceof Error && 
              (error.message.includes('proof verify failed') ||
              error.message.includes('Session expired'))) {
            
            if (sessionId) await sessions.delete(sessionId);
            clearSessionCookie(res);
            
            return res.status(401).json({
              error: 'Authentication error: Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
            details: JSON.stringify(error),
            requireRelogin: error instanceof ZkLoginError ? error.requireRelogin : false
          });
        }
        }

      case 'setRotationPosition': {
        // Extract parameters properly
        const { account, circleId, memberAddress, position } = req.body;
        
        // Validate required parameters
        if (!account) {
          return res.status(400).json({ error: 'account is required' });
        }
        if (!circleId) {
          return res.status(400).json({ error: 'circleId is required' });
        }
        if (typeof memberAddress === 'undefined') {
          return res.status(400).json({ error: 'memberAddress is required' });
        }
        if (typeof position === 'undefined') {
          return res.status(400).json({ error: 'position is required' });
        }

        try {
          console.log(`Setting rotation position for member ${memberAddress} to position ${position} in circle ${circleId}`);
          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'setRotationPosition',
            network: getCurrentNetwork(),
            circleId,
            userAddress: account.userAddr,
          });
          
          // Get the ZkLoginService instance
          const zkLoginService = enokiZkLoginService;
          
          // Send the transaction using the service's sendTransaction method
          const result = await zkLoginService.sendTransaction(
            account,
            (txb) => {
              // Build the transaction in this callback
              txb.moveCall({
                target: `${packageIdToUse}::njangi_circles::set_rotation_position`,
                arguments: [
                  txb.object(circleId), // circle
                  txb.pure.address(memberAddress.toLowerCase().startsWith('0x') ? memberAddress.toLowerCase() : `0x${memberAddress.toLowerCase()}`), // Normalize the address
                  txb.pure.u64(position), // position as u64 integer
                  txb.object(CLOCK_OBJECT_ID),
                ],
              });
            }
          );
          
          return res.status(200).json({
            digest: result.digest,
            status: result.status,
            message: `Set rotation position for member ${memberAddress} to position ${position}`,
            gasUsed: result.gasUsed,
          });
        } catch (error) {
          console.error('Error setting rotation position:', error);
          
          // Handle authentication errors
          if (error instanceof Error && 
              (error.message.includes('authentication') || 
               error.message.includes('login') || 
               error.message.includes('session') ||
               error.message.includes('expired'))) {
            return res.status(401).json({
              error: error.message,
              requireRelogin: true
            });
          }
          
          return res.status(500).json({
            error: 'Failed to set rotation position',
            details: error instanceof Error ? error.message : String(error),
            requireRelogin: error instanceof ZkLoginError ? error.requireRelogin : false
          });
        }
      }

      case 'reorderRotationPositions': {
        // Extract parameters properly
        const { account, circleId, newOrder, network: requestedNetwork } = req.body;
        
        // Validate required parameters
        if (!account) {
          return res.status(400).json({ error: 'account is required' });
        }
        if (!circleId) {
          return res.status(400).json({ error: 'circleId is required' });
        }
        if (!newOrder || !Array.isArray(newOrder) || newOrder.length === 0) {
          return res.status(400).json({ error: 'newOrder is required and must be a non-empty array' });
        }

        // Handle network parameter if provided by frontend
        if (requestedNetwork && (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet')) {
          console.log(`Frontend requested network: ${requestedNetwork}, current server network: ${getCurrentNetwork()}`);
        }

        try {
          console.log(`Reordering rotation positions for circle ${circleId} with ${newOrder.length} members on network: ${requestedNetwork || getCurrentNetwork()}`);
          
          // Get the ZkLoginService instance
          const instance = enokiZkLoginService;
          
          // Handle network switching like other endpoints
          const originalNetwork = getCurrentNetwork();
          let txResult;
          
          try {
            // Temporarily set the network to match the frontend request
            if (requestedNetwork && requestedNetwork !== originalNetwork) {
              console.log(`Temporarily switching server network from ${originalNetwork} to ${requestedNetwork} for reorderRotationPositions`);
              setCurrentNetwork(requestedNetwork as NetworkType);
              // Reinitialize the EnokiZkLoginService with the new network configuration
              instance.initializeWithNetwork();
            }
            
            // Get the correct package ID for this circle using the current network context
            const packageIdToUse = await resolveCirclePackageIdForTransaction({
              context: 'reorderRotationPositions',
              network: getCurrentNetwork(),
              circleId,
              userAddress: account.userAddr,
            });
            console.log(`Using package ID for reorderRotationPositions: ${packageIdToUse} (network: ${getCurrentNetwork()})`);
          
          // Send the transaction using the service's sendTransaction method
            txResult = await instance.sendTransaction(
            account,
            (txb) => {
              // Convert the addresses array to an array of arguments
                const addressArgs = newOrder.map((address: string) => 
                txb.pure.address(address.toLowerCase())
              );
              
              // Build the transaction in this callback
              txb.moveCall({
                  target: `${packageIdToUse}::njangi_circles::reorder_rotation_positions_entry`,
                arguments: [
                  txb.object(circleId), // circle
                  txb.makeMoveVec({ elements: addressArgs, type: 'address' }),
                  txb.object(CLOCK_OBJECT_ID),
                ],
              });
            }
          );
          } finally {
            // Always restore the original network and reinitialize the service
            if (requestedNetwork && requestedNetwork !== originalNetwork) {
              console.log(`Restoring server network back to ${originalNetwork}`);
              setCurrentNetwork(originalNetwork as NetworkType);
              instance.initializeWithNetwork();
            }
          }
          
          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            message: `Reordered rotation positions for circle ${circleId}`,
            gasUsed: txResult.gasUsed,
          });
        } catch (error) {
          console.error('Error reordering rotation positions:', error);
          
          // Handle authentication errors
          if (error instanceof Error && 
              (error.message.includes('authentication') || 
               error.message.includes('login') || 
               error.message.includes('session') ||
               error.message.includes('expired'))) {
            return res.status(401).json({
              error: error.message,
              requireRelogin: true
            });
          }
          
          return res.status(500).json({
            error: 'Failed to reorder rotation positions',
            details: error instanceof Error ? error.message : String(error),
            requireRelogin: error instanceof ZkLoginError ? error.requireRelogin : false
          });
        }
      }

      case 'depositUsdcDirect':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          // Print debug information about package ID and USDC coin type
          console.log('Debug info for depositUsdcDirect:');
          console.log('Current network package ID:', getCurrentPackageId());
          console.log('USDC_COIN_TYPE from import:', USDC_COIN_TYPE);
          
          // Validate required parameters
          const { circleId, walletId, usdcAmount, isSecurityDeposit } = req.body;
          if (!circleId || !walletId || !usdcAmount) {
            return res.status(400).json({
              error: 'Missing required parameters: circleId, walletId, usdcAmount'
            });
          }

          // An unresolved id ('', '0x0') normalizes into the all-zero object id
          // rather than failing, and the RPC then rejects the whole transaction
          // with an opaque "input objects are invalid". Reject it here instead.
          if (!isResolvedSuiObjectId(circleId) || !isResolvedSuiObjectId(walletId)) {
            return res.status(400).json({
              error: 'Circle details have not finished loading. Refresh the page and retry the deposit.'
            });
          }

          // Convert USDC amount to BigInt if it's not already
          const usdcAmountMicroUnits = typeof usdcAmount === 'string' ? 
            BigInt(usdcAmount) : BigInt(usdcAmount);

          // Validate session
          const session = await validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.'
            });
          }

          console.log(`Creating direct USDC deposit transaction for circle ${circleId}, wallet ${walletId}, amount ${usdcAmountMicroUnits} (${Number(usdcAmountMicroUnits) / 1e6} USDC)`);
          console.log(`Operation type: ${isSecurityDeposit ? 'Security Deposit' : 'Contribution'}`);
          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'depositUsdcDirect',
            network: getCurrentNetwork(),
            circleId,
            userAddress: session.account!.userAddr,
          });

          // First, perform all async operations to gather the necessary data
          const suiClient = await createSuiClient();
          
          // Get current versions of shared objects
          console.log(`Fetching current versions of shared objects (circle and wallet)...`);
          const circleObject = await suiClient.getObject({
            id: circleId,
            options: { showOwner: true, showContent: true }
          });
          
          const walletObject = await suiClient.getObject({
            id: walletId,
            options: { showOwner: true }
          });
          
          // Extract shared object versions
          let circleVersion: string | undefined;
          let walletVersion: string | undefined;
          
          // Check if objects have the expected owner type of "Shared"
          if (circleObject.data?.owner && 
              typeof circleObject.data.owner === 'object' && 
              'Shared' in circleObject.data.owner) {
            circleVersion = circleObject.data.owner.Shared.initial_shared_version;
            console.log(`Circle is a shared object with initial version ${circleVersion}`);
          } else {
            console.warn('Circle is not a shared object:', circleObject.data?.owner);
            throw new Error('Circle is not a shared object');
          }
          
          if (walletObject.data?.owner && 
              typeof walletObject.data.owner === 'object' && 
              'Shared' in walletObject.data.owner) {
            walletVersion = walletObject.data.owner.Shared.initial_shared_version;
            console.log(`Wallet is a shared object with initial version ${walletVersion}`);
          } else {
            console.warn('Wallet is not a shared object:', walletObject.data?.owner);
            throw new Error('Wallet is not a shared object');
          }
          
          // Get USDC coins from user's wallet
          const coinsResponse = await suiClient.getCoins({
            owner: session.account!.userAddr,
            coinType: USDC_COIN_TYPE
          });
          
          console.log(`Found ${coinsResponse.data.length} USDC coins in wallet`);
          
          if (coinsResponse.data.length === 0) {
            throw new Error("No USDC coins found in wallet");
          }
          
          // Calculate total available balance
          let totalAvailable = BigInt(0);
          for (const coin of coinsResponse.data) {
            totalAvailable += BigInt(coin.balance);
          }

          // Verify the exact deposit amount if it's a security deposit
          let verifiedAmount = usdcAmountMicroUnits;
          if (isSecurityDeposit) {
            try {
              console.log("Verifying security deposit amount from CircleConfig...");
              
              // Get the exact security deposit amount directly from the circle's content
              if (circleObject.data?.content && 'fields' in circleObject.data.content) {
                const circleFields = circleObject.data.content.fields as Record<string, unknown>;
                console.log("Circle fields:", circleFields);
                
                // First try to get from direct fields
                if (circleFields.security_deposit_usd) {
                  const securityDepositUsd = Number(circleFields.security_deposit_usd);
                  console.log(`Found security_deposit_usd directly in circle: ${securityDepositUsd} cents`);
                  
                  // Convert cents to microUSDC (1 cent = 10,000 microUSDC)
                  const exactDepositAmount = BigInt(Math.floor(securityDepositUsd * 10000));
                  console.log(`Converted to exactly ${formatMicroUnits(exactDepositAmount)} USDC (${exactDepositAmount} microUSDC)`);
                  
                  if (exactDepositAmount > BigInt(0)) {
                    console.log(`Setting exact deposit amount to ${exactDepositAmount} microUSDC`);
                    verifiedAmount = exactDepositAmount;
                  }
                }
              }
              
              // If not found in direct fields, try the dynamic fields
	              if (verifiedAmount === usdcAmountMicroUnits) {
	                const configFields = await getCircleConfigFields(suiClient, circleId);

	                if (configFields) {
	                  const securityDepositUsd = Number(configFields.security_deposit_usd || 0);

	                  console.log('Found security_deposit_usd in CircleConfig:', securityDepositUsd);
	                  console.log('Raw value from config:', configFields.security_deposit_usd);

	                  if (securityDepositUsd > 0) {
	                    const exactDepositAmount = BigInt(Math.floor(securityDepositUsd * 10000));
	                    console.log('Calculated requiredDepositAmount (in microUSDC):', exactDepositAmount.toString());
	                    console.log(`This equals ${formatMicroUnits(exactDepositAmount)} USDC`);

	                    verifiedAmount = exactDepositAmount;
	                  }
	                }
	              }
            } catch (err) {
              console.warn("Error verifying security deposit amount:", err);
              // Continue with the original amount
            }
          } else {
            // This is a contribution, not a security deposit
            try {
	              console.log("Verifying contribution amount from CircleConfig...");

	              const configFields = await getCircleConfigFields(suiClient, circleId);

	              if (configFields) {
	                const contributionAmountUsd = Number(
	                  configFields.contribution_amount_local || configFields.contribution_amount_usd || 0,
	                );

	                console.log('Found contribution_amount_local in CircleConfig:', contributionAmountUsd);
	                console.log(
	                  'Raw value from config:',
	                  configFields.contribution_amount_local || configFields.contribution_amount_usd,
	                );

	                if (contributionAmountUsd > 0) {
	                  const exactContributionAmount = BigInt(Math.floor(contributionAmountUsd * 10000));
	                  console.log('Calculated contribution amount (in microUSDC):', exactContributionAmount.toString());
	                  console.log(`This equals ${formatMicroUnits(exactContributionAmount)} USDC`);

	                  verifiedAmount = exactContributionAmount;
	                }
	              }

              // If we couldn't find the amount in the config, try direct fields
              if (verifiedAmount === usdcAmountMicroUnits && circleObject.data?.content && 'fields' in circleObject.data.content) {
                const circleFields = circleObject.data.content.fields as Record<string, unknown>;
                
                // Try to find contribution_amount_usd in direct fields
                if (circleFields.contribution_amount_usd) {
                  const contributionAmountUsd = Number(circleFields.contribution_amount_usd);
                  console.log(`Found contribution_amount_usd directly in circle: ${contributionAmountUsd} cents`);
                  
                  // Convert cents to microUSDC
                  const exactContributionAmount = BigInt(Math.floor(contributionAmountUsd * 10000));
                  console.log(`Converted to exactly ${formatMicroUnits(exactContributionAmount)} USDC (${exactContributionAmount} microUSDC)`);
                  
                  if (exactContributionAmount > BigInt(0)) {
                    verifiedAmount = exactContributionAmount;
                  }
                }
              }
            } catch (err) {
              console.warn("Error verifying contribution amount:", err);
              // Continue with the original amount
            }
          }
          
          console.log(`Total available: ${formatMicroUnits(totalAvailable)} USDC`);
          console.log(`Required amount: ${formatMicroUnits(verifiedAmount)} USDC (${verifiedAmount} microUSDC)`);
          
          // Ensure we have enough balance
          if (totalAvailable < verifiedAmount) {
            throw new Error(`Insufficient USDC balance. Need ${formatMicroUnits(verifiedAmount)} USDC but only have ${formatMicroUnits(totalAvailable)} USDC.`);
          }
          
          // Sort coins by balance (largest first)
          coinsResponse.data.sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));
          
          // Now execute the transaction with a synchronous transaction builder function
          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              
              // Call the appropriate deposit function based on operation type
              if (isSecurityDeposit) {
                console.log(`Calling njangi_circles::member_deposit_security_deposit for USDC with shared objects`);
                
                // Log the exact expected amount in both formats
                console.log(`Using EXACT deposit amount: ${verifiedAmount} microUSDC = $${Number(verifiedAmount) / 1e6} USDC`);
                
                // If single coin has enough, use it directly
                if (BigInt(coinsResponse.data[0].balance) >= verifiedAmount) {
                  const primaryCoinId = coinsResponse.data[0].coinObjectId;
                  console.log(`Using primary coin ${primaryCoinId} with balance ${formatMicroUnits(BigInt(coinsResponse.data[0].balance))} USDC`);
                  
                  // Split the exact required amount
                  const depositCoin = txb.splitCoins(
                    txb.object(primaryCoinId),
                    [txb.pure.u64(verifiedAmount)]
                  );
                  
                  // Call the deposit function with the split coin
                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::member_deposit_security_deposit`,
                    arguments: [
                      txb.sharedObjectRef({ objectId: circleId, initialSharedVersion: circleVersion, mutable: true }),
                      txb.sharedObjectRef({ objectId: walletId, initialSharedVersion: walletVersion, mutable: true }),
                      depositCoin,
                      txb.object("0x6")
                    ],
                    typeArguments: [USDC_COIN_TYPE]
                  });
                } else {
                  // Need to use multiple coins - use the helper function that will merge coins and split the right amount
                  console.log(`No single coin has enough USDC. Using deposit helper to collect from multiple coins`);
                  
                  // Create an array of all coin IDs we have
                  const allCoinIds = coinsResponse.data.map(coin => coin.coinObjectId);
                  
                  // Instead of looking for a non-existent function, we'll first merge the coins and then use the standard function
                  // First, gather all available coins
                  console.log(`Merging ${allCoinIds.length} USDC coins to create sufficient balance`);
                  
                  // If we have multiple coins, merge them into the first one
                  if (allCoinIds.length > 1) {
                    // Get the primary coin
                    const primaryCoinId = allCoinIds[0];
                    const otherCoinIds = allCoinIds.slice(1);
                    
                    // Merge all other coins into the primary coin
                    txb.mergeCoins(
                      txb.object(primaryCoinId),
                      otherCoinIds.map(id => txb.object(id))
                    );
                    
                    // Now split the exact amount needed from the merged coin
                    const depositCoin = txb.splitCoins(
                      txb.object(primaryCoinId),
                      [txb.pure.u64(verifiedAmount)]
                    );
                    
                    // Add debug logs for the contribution function call
                    console.log(`DEBUG: Using package ID for contribute: ${packageIdToUse}`);
                    console.log(`DEBUG: Using USDC_COIN_TYPE for contribute: ${USDC_COIN_TYPE}`);
                    
                    // We need to use member_deposit_security_deposit instead of contribute for USDC
                    txb.moveCall({
                      target: `${packageIdToUse}::njangi_circles::member_deposit_security_deposit`,
                      typeArguments: [USDC_COIN_TYPE],
                      arguments: [
                        txb.sharedObjectRef({ objectId: circleId, initialSharedVersion: circleVersion, mutable: true }),
                        txb.sharedObjectRef({ objectId: walletId, initialSharedVersion: walletVersion, mutable: true }),
                        depositCoin,
                        txb.object("0x6")
                      ]
                    });
                  } else {
                    // This is a fallback case that should rarely happen
                    console.log(`Only have one coin but it doesn't have enough balance. This is unexpected.`);
                    throw new Error(`Insufficient USDC balance in coin. Need ${formatMicroUnits(verifiedAmount)} USDC.`);
                  }
                }
              } else {
                // Regular contribution case
                console.log(`Calling njangi_circles::contribute_stablecoin for USDC contributions with shared objects`);
                
                // Log the exact expected amount in both formats
                console.log(`Using contribution amount: ${verifiedAmount} microUSDC = $${Number(verifiedAmount) / 1e6} USDC`);
                
                // If single coin has enough, use it directly
                if (BigInt(coinsResponse.data[0].balance) >= verifiedAmount) {
                  const primaryCoinId = coinsResponse.data[0].coinObjectId;
                  console.log(`Using primary coin ${primaryCoinId} with balance ${formatMicroUnits(BigInt(coinsResponse.data[0].balance))} USDC`);
                  
                  // Split the exact required amount
                  const depositCoin = txb.splitCoins(
                    txb.object(primaryCoinId),
                    [txb.pure.u64(verifiedAmount)]
                  );
                  
                  // Call the contribute_stablecoin function with the split coin
                  txb.moveCall({
                    target: `${packageIdToUse}::njangi_circles::contribute_stablecoin`,
                    typeArguments: [USDC_COIN_TYPE],
                    arguments: [
                      txb.sharedObjectRef({ objectId: circleId, initialSharedVersion: circleVersion, mutable: true }),
                      txb.sharedObjectRef({ objectId: walletId, initialSharedVersion: walletVersion, mutable: true }),
                      depositCoin,
                      txb.object("0x6") // Clock object
                    ]
                  });
                } else {
                  // Need to use multiple coins - use the helper function that will merge coins and split the right amount
                  console.log(`No single coin has enough USDC. Using contribute helper to collect from multiple coins`);
                  
                  // Create an array of all coin IDs we have
                  const allCoinIds = coinsResponse.data.map(coin => coin.coinObjectId);
                  
                  // First merge the coins and then use the standard function
                  console.log(`Merging ${allCoinIds.length} USDC coins to create sufficient balance`);
                  
                  // If we have multiple coins, merge them into the first one
                  if (allCoinIds.length > 1) {
                    // Get the primary coin
                    const primaryCoinId = allCoinIds[0];
                    const otherCoinIds = allCoinIds.slice(1);
                    
                    // Merge all other coins into the primary coin
                    txb.mergeCoins(
                      txb.object(primaryCoinId),
                      otherCoinIds.map(id => txb.object(id))
                    );
                    
                    // Now split the exact amount needed from the merged coin
                    const depositCoin = txb.splitCoins(
                      txb.object(primaryCoinId),
                      [txb.pure.u64(verifiedAmount)]
                    );
                    
                    // Add debug logs for the contribute_stablecoin function call
                    console.log(`DEBUG: Using package ID for contribute_stablecoin: ${packageIdToUse}`);
                    console.log(`DEBUG: Using USDC_COIN_TYPE for contribute_stablecoin: ${USDC_COIN_TYPE}`);
                    
                    // Call contribute_stablecoin with the merged and split coin
                    txb.moveCall({
                      target: `${packageIdToUse}::njangi_circles::contribute_stablecoin`,
                      typeArguments: [USDC_COIN_TYPE],
                      arguments: [
                        txb.sharedObjectRef({ objectId: circleId, initialSharedVersion: circleVersion, mutable: true }),
                        txb.sharedObjectRef({ objectId: walletId, initialSharedVersion: walletVersion, mutable: true }),
                        depositCoin,
                        txb.object("0x6") // Clock object
                      ]
                    });
                  } else {
                    // This is a fallback case that should rarely happen
                    console.log(`Only have one coin but it doesn't have enough balance. This is unexpected.`);
                    throw new Error(`Insufficient USDC balance in coin. Need ${formatMicroUnits(verifiedAmount)} USDC.`);
                  }
                }
              }
            },
            { gasBudget: 100000000 } // Higher gas budget for complex transaction
          );
          
          console.log('Direct USDC deposit transaction successful:', txResult);
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Direct USDC deposit error:', error);
          
          if (error instanceof Error && 
              (error.message.includes('proof verify failed') ||
               error.message.includes('Session expired'))) {
            
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({ 
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to process USDC deposit'
          });
        }
        break;

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

      case 'adminSetMaxMembers': {
        // Handle network parameter if provided by frontend
        const requestedNetwork = req.body.network;
        if (requestedNetwork && (requestedNetwork === 'testnet' || requestedNetwork === 'mainnet')) {
          console.log(`Frontend requested network: ${requestedNetwork}, current server network: ${getCurrentNetwork()}`);
        }

        try {
          // Validate required parameters
          if (!account) {
            return res.status(400).json({ error: 'Account data is required' });
          }
          if (!circleId) {
            return res.status(400).json({ error: 'Circle ID is required' });
          }
          if (typeof newMaxMembers !== 'number' || newMaxMembers < 3) { // Basic validation
            return res.status(400).json({ error: 'Invalid new maximum members value. Must be a number >= 3.' });
          }

          // Validate session
          if (!sessionId) {
            return res.status(401).json({ error: 'No session found. Please authenticate first.' });
          }
          const session = await validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({
              error: 'Invalid session: No account data found. Please authenticate first.',
              requireRelogin: true
            });
          }

          // Billing SOFT gate: the requested member cap must fit the
          // admin's plan (free 3 / premium 20). admin_set_max_members is a
          // public Move function reachable from the client-side signer, so
          // this is upgrade-funnel friction, NOT security — and it never
          // touches recovery/claim/withdraw paths. No-op while billing is
          // off; fails open on billing infrastructure errors.
          try {
            await assertWithinMemberLimit(newMaxMembers, {
              sub: session.account.sub,
              aud: session.account.aud,
              userAddress: session.account.userAddr,
            });
          } catch (gateError) {
            if (gateError instanceof EntitlementError) {
              return res.status(402).json(entitlementErrorBody(gateError));
            }
            console.warn(
              '[zkLogin] adminSetMaxMembers billing gate skipped (fail-open):',
              gateError,
            );
          }

          console.log(`Setting max members for circle ${circleId} to ${newMaxMembers} on network: ${requestedNetwork || getCurrentNetwork()}`);

          // Handle network switching like other endpoints
          const originalNetwork = getCurrentNetwork();
          let txResult;
          
          try {
            // Temporarily set the network to match the frontend request
            if (requestedNetwork && requestedNetwork !== originalNetwork) {
              console.log(`Temporarily switching server network from ${originalNetwork} to ${requestedNetwork} for adminSetMaxMembers`);
              setCurrentNetwork(requestedNetwork as NetworkType);
              // Reinitialize the EnokiZkLoginService with the new network configuration
              instance.initializeWithNetwork();
            }
            
            // Get the effective transaction package ID for this circle on the current network.
            const packageIdToUse = await resolveCirclePackageIdForTransaction({
              context: 'adminSetMaxMembers',
              network: getCurrentNetwork(),
              circleId,
              userAddress: account.userAddr,
            });
            console.log(`Using package ID for adminSetMaxMembers: ${packageIdToUse} (network: ${getCurrentNetwork()})`);

          // Send the transaction
            txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              txb.moveCall({
                  target: `${packageIdToUse}::njangi_circles::admin_set_max_members`,
                arguments: [
                  txb.object(circleId),
                  txb.pure.u64(newMaxMembers),
                  txb.object(CLOCK_OBJECT_ID),
                ],
              });
            },
            { gasBudget: 50000000 } // Standard gas budget should be sufficient
          );
          } finally {
            // Always restore the original network and reinitialize the service
            if (requestedNetwork && requestedNetwork !== originalNetwork) {
              console.log(`Restoring server network back to ${originalNetwork}`);
              setCurrentNetwork(originalNetwork as NetworkType);
              instance.initializeWithNetwork();
            }
          }

          console.log('Set max members transaction successful:', txResult);
          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });

        } catch (error) {
          console.error('Error setting max members:', error);

          // Handle authentication errors
          if (error instanceof Error &&
              (error.message.includes('proof verify failed') ||
              error.message.includes('Session expired') ||
              error.message.includes('re-authenticate'))) {

            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }

          // Handle specific contract errors
          if (error instanceof Error) {
            if (error.message.includes('ENotAdmin') || error.message.includes('ENotCircleAdmin') || error.message.includes(', 7)')) {
              return res.status(403).json({ error: 'Only the circle admin can perform this action.' });
            }
            if (error.message.includes('ECircleIsActive') || error.message.includes(', 55)')) {
              return res.status(400).json({ error: 'Cannot change max members: The circle is already active.' });
            }
            if (error.message.includes('EInvalidMaxMembersLimit') || error.message.includes(', 56)')) {
              return res.status(400).json({ error: 'Invalid maximum member limit. Ensure it is at least 3 and not less than the current number of members.' });
            }
          }

          // Generic error
          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to set maximum members',
            details: error instanceof Error ? error.stack : String(error),
            requireRelogin: false
          });
        }
      } // End case 'adminSetMaxMembers'

      case 'adminTriggerPayout': {
        // Handle network switching for correct package ID
        const { network: requestedNetwork } = req.body;
        const originalNetwork = getCurrentNetwork();
        
        try {
          // Switch to requested network if specified
          if (requestedNetwork && requestedNetwork !== originalNetwork) {
            console.log(`🌍 adminTriggerPayout: Switching network from ${originalNetwork} to ${requestedNetwork}`);
            setCurrentNetwork(requestedNetwork as 'testnet' | 'mainnet');
            // CRITICAL: Reinitialize the service with the new network's RPC URL
            instance.initializeWithNetwork();
          }
          
          // Validate required parameters
          if (!account) {
            return res.status(400).json({ error: 'Account data is required' });
          }
          if (!circleId) {
            return res.status(400).json({ error: 'Circle ID is required' });
          }
          if (!req.body.walletId) {
            return res.status(400).json({ error: 'Wallet ID is required' });
          }

          // Validate session
          if (!sessionId) {
            return res.status(401).json({ error: 'No session found. Please authenticate first.' });
          }
          const session = await validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({
              error: 'Invalid session: No account data found. Please authenticate first.',
              requireRelogin: true
            });
          }

          console.log(`Admin triggering automatic payout for circle ${circleId} with wallet ${req.body.walletId} on network ${getCurrentNetwork()}`);

          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'adminTriggerPayout',
            network: getCurrentNetwork(),
            circleId,
            userAddress: session.account.userAddr,
          });
          console.log(`Using package ID ${packageIdToUse} for circle ${circleId} on ${getCurrentNetwork()}`);
          const USDC_TYPE = getCurrentCoinTypes().USDC;

          // Send the transaction
          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              // Phase 1 compliance update: the on-chain function is now
              // the permissionless `trigger_payout`. Anyone (admin or otherwise)
              // can call it once every member has contributed; the recipient
              // is derived deterministically from the rotation order.
              txb.moveCall({
                target: `${packageIdToUse}::njangi_payments::trigger_payout`,
                arguments: [
                  txb.object(circleId),
                  txb.object(req.body.walletId),
                  txb.object("0x6"), // Clock object
                ],
                typeArguments: [USDC_TYPE],
              });
            },
            { gasBudget: 100000000 } // Higher gas budget for payout operation
          );

          console.log('Admin trigger payout transaction successful:', txResult);
          
          // Restore original network
          if (requestedNetwork && requestedNetwork !== originalNetwork) {
            setCurrentNetwork(originalNetwork as 'testnet' | 'mainnet');
            instance.initializeWithNetwork();
          }
          
          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });

        } catch (error) {
          // Restore original network on error
          if (requestedNetwork && requestedNetwork !== originalNetwork) {
            setCurrentNetwork(originalNetwork as 'testnet' | 'mainnet');
            instance.initializeWithNetwork();
          }
          console.error('Error triggering payout:', error);

          // Handle authentication errors
          if (error instanceof Error &&
              (error.message.includes('proof verify failed') ||
              error.message.includes('Session expired') ||
              error.message.includes('re-authenticate'))) {

            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }

          // Handle specific contract errors
          if (error instanceof Error) {
            if (error.message.includes('ENotAdmin') || error.message.includes('ENotCircleAdmin') || error.message.includes(', 7)')) {
              return res.status(403).json({ error: 'Only the circle admin can trigger payouts.' });
            }
            if (error.message.includes('ECircleNotActive') || error.message.includes(', 54)')) {
              return res.status(400).json({ error: 'Cannot trigger payout: The circle is not active.' });
            }
            if (error.message.includes('EPayoutAlreadyProcessed') || error.message.includes(', 23)')) {
              return res.status(400).json({ error: 'The current member in rotation has already received a payout for this cycle.' });
            }
            if (error.message.includes('EInsufficientTreasuryBalance') || error.message.includes(', 25)')) {
              return res.status(400).json({ error: 'Insufficient funds in treasury to process the payout.' });
            }
          }

          // Generic error
          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to trigger payout',
            details: error instanceof Error ? error.stack : String(error),
            requireRelogin: false
          });
        }
      } // End case 'adminTriggerPayout'

      // Phase 2 cleanup: 'adminTriggerUsdcPayout' was a duplicate of
      // 'adminTriggerPayout' that targeted the deleted Move function
      // `admin_trigger_usdc_payout`. The new permissionless `trigger_payout<T>`
      // covers both routing paths via the CoinType generic, so any caller
      // that previously dispatched 'adminTriggerUsdcPayout' should send
      // 'adminTriggerPayout' instead with the desired CoinType.

      // ====================================================================
      // Phase 3: per-cycle CycleEscrow dispatch cases.
      //
      // These expose `njangi_cycle_escrow::open_cycle / contribute /
      // finalize_and_redeem` through the legacy server-signing flow so that
      // existing UI code paths can migrate without also rewriting their
      // signing layer. New flows should prefer `useZkLoginSigner` on the
      // client so the ephemeral key never leaves the browser.
      // ====================================================================

      case 'openCycleEscrow': {
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }
        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }
        try {
          const session = await validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ error: 'Invalid session', requireRelogin: true });
          }
          const { circleId: escrowCircleId, coinType } = req.body as {
            circleId?: string;
            coinType?: string;
          };
          if (!escrowCircleId) return res.status(400).json({ error: 'circleId required' });
          if (!coinType) return res.status(400).json({ error: 'coinType required' });

          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'openCycleEscrow',
            network: getCurrentNetwork(),
            circleId: escrowCircleId,
            userAddress: session.account.userAddr,
          });

          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              txb.moveCall({
                target: `${packageIdToUse}::njangi_cycle_escrow::open_cycle`,
                typeArguments: [coinType],
                arguments: [txb.object(escrowCircleId), txb.object('0x6')],
              });
            },
            { gasBudget: 80_000_000 },
          );
          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed,
          });
        } catch (error) {
          console.error('openCycleEscrow failed', error);
          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to open cycle escrow',
          });
        }
      }

      case 'contributeToCycleEscrow': {
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }
        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }
        try {
          const session = await validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ error: 'Invalid session', requireRelogin: true });
          }
          const { escrowId, paymentCoinId, coinType } = req.body as {
            escrowId?: string;
            paymentCoinId?: string;
            coinType?: string;
          };
          if (!escrowId) return res.status(400).json({ error: 'escrowId required' });
          if (!paymentCoinId) return res.status(400).json({ error: 'paymentCoinId required' });
          if (!coinType) return res.status(400).json({ error: 'coinType required' });

          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'contributeToCycleEscrow',
            network: getCurrentNetwork(),
            circleId: escrowId,
            userAddress: session.account.userAddr,
          });

          // Build the contribute move call once; reused by both the sponsored
          // and self-paid paths so they can never drift.
          const buildContribute = (txb: Transaction) => {
            txb.setSender(session.account!.userAddr);
            txb.moveCall({
              target: `${packageIdToUse}::njangi_cycle_escrow::contribute`,
              typeArguments: [coinType],
              arguments: [txb.object(escrowId), txb.object(paymentCoinId)],
            });
          };

          // Self-paid only — see the note on paySecurityDeposit above.
          // Sponsorship now runs entirely client-side so the user's signature
          // is never minted here.
          const sponsored = false;
          const txResult: { digest: string; status: string; gasUsed?: unknown } =
            await instance.sendTransaction(
              session.account,
              buildContribute,
              { gasBudget: 80_000_000 },
            );

          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed,
            sponsored,
          });
        } catch (error) {
          console.error('contributeToCycleEscrow failed', error);
          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to contribute to cycle escrow',
          });
        }
      }

      case 'finalizeAndRedeemCycleEscrow': {
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }
        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }
        try {
          const session = await validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ error: 'Invalid session', requireRelogin: true });
          }
          const { escrowId, coinType } = req.body as {
            escrowId?: string;
            coinType?: string;
          };
          if (!escrowId) return res.status(400).json({ error: 'escrowId required' });
          if (!coinType) return res.status(400).json({ error: 'coinType required' });

          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'finalizeAndRedeemCycleEscrow',
            network: getCurrentNetwork(),
            circleId: escrowId,
            userAddress: session.account.userAddr,
          });

          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              txb.moveCall({
                target: `${packageIdToUse}::njangi_cycle_escrow::finalize_and_redeem`,
                typeArguments: [coinType],
                arguments: [txb.object(escrowId), txb.object('0x6')],
              });
            },
            { gasBudget: 100_000_000 },
          );
          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed,
          });
        } catch (error) {
          console.error('finalizeAndRedeemCycleEscrow failed', error);
          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to finalize and redeem',
          });
        }
      }

      case 'resumeCycle':
        // Validate required parameters
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }
        
        if (!circleId) {
          return res.status(400).json({ error: 'Circle ID is required' });
        }
        
        try {
          // Validate the session
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            // Just validate the session without storing the result
            await validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }

          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'resumeCycle',
            network: getCurrentNetwork(),
            circleId,
            userAddress: account.userAddr,
          });

          // Send transaction using zkLogin service
          const txResult = await instance.sendTransaction(
            account,
            (txb: Transaction) => {
              txb.setSender(account.userAddr);
              
              // Call the resume_cycle function
              txb.moveCall({
                target: `${packageIdToUse}::njangi_circles::resume_cycle`,
                arguments: [
                  txb.object(circleId),
                  txb.object(CLOCK_OBJECT_ID) // Clock object
                ]
              });
            },
            { gasBudget: 50000000 } // Standard gas budget
          );
          
          console.log('Resume cycle transaction successful:', txResult);
          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Error resuming cycle:', error);
          
          // Handle authentication errors
          if (error instanceof Error &&
              (error.message.includes('proof verify failed') ||
              error.message.includes('Session expired') ||
              error.message.includes('re-authenticate'))) {
            
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          // Handle specific contract errors
          if (error instanceof Error) {
            if (error.message.includes('ENotAdmin') || error.message.includes('ENotCircleAdmin')) {
              return res.status(403).json({ error: 'Only the circle admin can resume the cycle.' });
            }
            if (error.message.includes('ECircleNotActive')) {
              return res.status(400).json({ error: 'Cannot resume cycle: The circle is not active.' });
            }
            if (!error.message.includes('paused') || !error.message.includes('cycle')) {
              return res.status(400).json({ error: 'The circle is not paused after a cycle.' });
            }
          }
          
          // Generic error
          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to resume cycle',
            details: error instanceof Error ? error.stack : String(error),
            requireRelogin: false
          });
        }
        break;

      case 'proposeEmergencyStop':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!circleId) {
          return res.status(400).json({ error: 'Circle ID is required' });
        }

        try {
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            await validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }

          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'proposeEmergencyStop',
            network: getCurrentNetwork(),
            circleId,
            userAddress: account.userAddr,
          });

          const txResult = await instance.sendTransaction(
            account,
            (txb: Transaction) => {
              txb.setSender(account.userAddr);
              txb.moveCall({
                target: `${packageIdToUse}::njangi_circles::propose_emergency_stop`,
                arguments: [
                  txb.object(circleId),
                  txb.object(CLOCK_OBJECT_ID)
                ]
              });
            },
            { gasBudget: 50000000 }
          );

          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Error proposing emergency stop:', error);

          if (error instanceof Error &&
              (error.message.includes('proof verify failed') ||
              error.message.includes('Session expired') ||
              error.message.includes('re-authenticate'))) {
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }

          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to propose emergency stop',
            requireRelogin: false
          });
        }

      case 'voteEmergencyStop':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!circleId) {
          return res.status(400).json({ error: 'Circle ID is required' });
        }

        if (typeof req.body.yesVote !== 'boolean') {
          return res.status(400).json({ error: 'yesVote must be a boolean' });
        }

        try {
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            await validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }

          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'voteEmergencyStop',
            network: getCurrentNetwork(),
            circleId,
            userAddress: account.userAddr,
          });

          const txResult = await instance.sendTransaction(
            account,
            (txb: Transaction) => {
              txb.setSender(account.userAddr);
              txb.moveCall({
                target: `${packageIdToUse}::njangi_circles::vote_emergency_stop`,
                arguments: [
                  txb.object(circleId),
                  txb.pure.bool(req.body.yesVote),
                  txb.object(CLOCK_OBJECT_ID)
                ]
              });
            },
            { gasBudget: 50000000 }
          );

          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Error voting on emergency stop:', error);

          if (error instanceof Error &&
              (error.message.includes('proof verify failed') ||
              error.message.includes('Session expired') ||
              error.message.includes('re-authenticate'))) {
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }

          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to vote on emergency stop',
            requireRelogin: false
          });
        }

      case 'executeRecovery': {
        const recoveryWalletId = req.body.walletId;

        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!circleId) {
          return res.status(400).json({ error: 'Circle ID is required' });
        }

        if (!recoveryWalletId || typeof recoveryWalletId !== 'string') {
          return res.status(400).json({ error: 'Custody wallet ID is required' });
        }

        try {
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            await validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }

          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'executeRecovery',
            network: getCurrentNetwork(),
            circleId,
            userAddress: account.userAddr,
          });
          const suiClient = await createSuiClient();
          const stablecoinTypeArg = await resolveRecoveryWalletCoinType(suiClient, recoveryWalletId);

          const txResult = await instance.sendTransaction(
            account,
            (txb: Transaction) => {
              txb.setSender(account.userAddr);
              txb.moveCall({
                target: `${packageIdToUse}::njangi_circles::execute_recovery`,
                typeArguments: [stablecoinTypeArg],
                arguments: [
                  txb.object(circleId),
                  txb.object(recoveryWalletId),
                  txb.object(CLOCK_OBJECT_ID)
                ]
              });
            },
            { gasBudget: 100000000 }
          );

          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Error executing recovery:', error);

          if (error instanceof Error &&
              (error.message.includes('proof verify failed') ||
              error.message.includes('Session expired') ||
              error.message.includes('re-authenticate'))) {
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }

          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to execute recovery',
            requireRelogin: false
          });
        }
      }

      case 'triggerAutoRelease': {
        const recoveryWalletId = req.body.walletId;

        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!circleId) {
          return res.status(400).json({ error: 'Circle ID is required' });
        }

        if (!recoveryWalletId || typeof recoveryWalletId !== 'string') {
          return res.status(400).json({ error: 'Custody wallet ID is required' });
        }

        try {
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            await validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }

          const packageIdToUse = await resolveCirclePackageIdForTransaction({
            context: 'triggerAutoRelease',
            network: getCurrentNetwork(),
            circleId,
            userAddress: account.userAddr,
          });
          const suiClient = await createSuiClient();
          const stablecoinTypeArg = await resolveRecoveryWalletCoinType(suiClient, recoveryWalletId);

          const txResult = await instance.sendTransaction(
            account,
            (txb: Transaction) => {
              txb.setSender(account.userAddr);
              txb.moveCall({
                target: `${packageIdToUse}::njangi_circles::trigger_auto_release`,
                typeArguments: [stablecoinTypeArg],
                arguments: [
                  txb.object(circleId),
                  txb.object(recoveryWalletId),
                  txb.object(CLOCK_OBJECT_ID)
                ]
              });
            },
            { gasBudget: 100000000 }
          );

          return res.status(200).json({
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Error triggering auto-release:', error);

          if (error instanceof Error &&
              (error.message.includes('proof verify failed') ||
              error.message.includes('Session expired') ||
              error.message.includes('re-authenticate'))) {
            if (sessionId) {
              await sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }

          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to trigger auto-release',
            requireRelogin: false
          });
        }
      }

      // Phase 2 cleanup: payoutSecurityDepositSui, payoutSecurityDepositStablecoin,
      // and the legacy yield-management dispatch cases (createYieldConfig,
      // changeYieldStrategy, generateYieldOnDeposit, collectYield,
      // emergencyWithdrawYield, addCetusLiquidity, processSecurityDeposits) were
      // removed. They targeted Move functions deleted in the Phase 1 compliance
      // redesign (admin_payout_security_deposit_*, njangi_yield_integration::*).
      // Recovery refunds now flow through njangi_circles::admin_remove_member,
      // and the yield product line is out of scope until separately audited.

      case 'sendTokens':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          // Extract transfer parameters from request body
          const { recipientAddress, amount, coinType, memo } = req.body;

          // Validate required parameters
          if (!recipientAddress || !amount || !coinType) {
            return res.status(400).json({
              error: 'Missing required parameters: recipientAddress, amount, coinType'
            });
          }

          // Validate session
          const session = await validateSession(sessionId, 'sendTokens');
          
          if (!session.account) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.',
              requireRelogin: true
            });
          }

          // Verify session matches account data
          if (session.account.userAddr !== account.userAddr) {
            await sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Session mismatch: Please refresh your authentication',
              requireRelogin: true
            });
          }

          // Validate addresses
          const isValidAddress = (addr: string): boolean => {
            if (!addr) return false;
            const cleanAddr = addr.startsWith('0x') ? addr.slice(2) : addr;
            const hexRegex = /^[0-9a-fA-F]+$/;
            return hexRegex.test(cleanAddr) && (cleanAddr.length === 64 || cleanAddr.length === 40);
          };

          if (!isValidAddress(recipientAddress)) {
            return res.status(400).json({
              error: 'Invalid recipient address format'
            });
          }

          const normalizedRecipient = recipientAddress.startsWith('0x') ? recipientAddress : `0x${recipientAddress}`;
          const transferAmount = BigInt(amount);

          if (transferAmount <= 0) {
            return res.status(400).json({
              error: 'Amount must be greater than 0'
            });
          }

          // Prevent self-transfer
          if (normalizedRecipient.toLowerCase() === session.account.userAddr.toLowerCase()) {
            return res.status(400).json({
              error: 'Cannot transfer to your own address'
            });
          }

          console.log('Executing token transfer:', {
            from: session.account.userAddr,
            to: normalizedRecipient,
            amount: transferAmount.toString(),
            coinType,
            memo
          });

          // For non-SUI transfers, pre-select coins
          const selectedCoins: { objectId: string; balance: bigint }[] = [];
          
          if (coinType !== '0x2::sui::SUI') {
            const suiClient = await createSuiClient();
            
            // Get user's coins for this type
            const coins = await suiClient.getCoins({
              owner: session.account.userAddr,
              coinType: coinType
            });

            if (coins.data.length === 0) {
              return res.status(400).json({
                error: `No ${coinType} coins found in your wallet`
              });
            }

            // Sort coins by balance (largest first) for efficient selection
            const sortedCoins = coins.data.sort((a, b) => 
              Number(BigInt(b.balance) - BigInt(a.balance))
            );

            let totalSelected = BigInt(0);

            // Select coins to cover the transfer amount
            for (const coin of sortedCoins) {
              if (totalSelected >= transferAmount) break;
              
              const coinBalance = BigInt(coin.balance);
              selectedCoins.push({ objectId: coin.coinObjectId, balance: coinBalance });
              totalSelected += coinBalance;
              
              if (totalSelected >= transferAmount) {
                break;
              }
            }

            if (totalSelected < transferAmount) {
              return res.status(400).json({
                error: `Insufficient balance. Available: ${totalSelected.toString()}, Required: ${transferAmount.toString()}`
              });
            }
          }

          // Execute the transfer using zkLogin service
          const result = await instance.sendTransaction(
            session.account,
            (txb) => {
              if (coinType === '0x2::sui::SUI') {
                // For SUI transfers, split from gas
                const [coin] = txb.splitCoins(txb.gas, [transferAmount]);
                txb.transferObjects([coin], normalizedRecipient);
              } else {
                // For other coin types, use pre-selected coins
                if (selectedCoins.length === 0) {
                  throw new Error('No coins selected for transfer');
                }

                if (selectedCoins.length === 1) {
                  // Single coin case
                  const coinBalance = selectedCoins[0].balance;
                  
                  if (coinBalance === transferAmount) {
                    // Transfer the entire coin
                    txb.transferObjects([txb.object(selectedCoins[0].objectId)], normalizedRecipient);
                  } else {
                    // Split the coin and transfer the exact amount
                    const [splitCoin] = txb.splitCoins(
                      txb.object(selectedCoins[0].objectId), 
                      [transferAmount]
                    );
                    txb.transferObjects([splitCoin], normalizedRecipient);
                  }
                } else {
                  // Multiple coins case - merge them first
                  const primaryCoin = selectedCoins[0];
                  const otherCoins = selectedCoins.slice(1);
                  
                  // Merge all coins into the primary coin
                  if (otherCoins.length > 0) {
                    txb.mergeCoins(
                      txb.object(primaryCoin.objectId),
                      otherCoins.map(coin => txb.object(coin.objectId))
                    );
                  }
                  
                  // Calculate total balance
                  const totalSelected = selectedCoins.reduce((sum, coin) => sum + coin.balance, BigInt(0));
                  
                  // Now split the exact amount from the merged coin
                  if (totalSelected === transferAmount) {
                    // Transfer the entire merged coin
                    txb.transferObjects([txb.object(primaryCoin.objectId)], normalizedRecipient);
                  } else {
                    // Split the exact amount
                    const [splitCoin] = txb.splitCoins(
                      txb.object(primaryCoin.objectId), 
                      [transferAmount]
                    );
                    txb.transferObjects([splitCoin], normalizedRecipient);
                  }
                }
              }

              // Add memo as a custom event if provided
              if (memo) {
                console.log('Transfer memo:', memo);
              }
            },
            {
              gasBudget: 10000000, // 0.01 SUI - reasonable for simple token transfer
            }
          );

          if (result.status === 'success') {
            console.log('Token transfer successful:', result.digest);
            return res.status(200).json({
              digest: result.digest,
              gasUsed: result.gasUsed
            });
          } else {
            console.error('Token transfer failed:', result.error);
            return res.status(500).json({
              error: result.error || 'Transfer failed'
            });
          }

        } catch (error) {
          console.error('Error in sendTokens action:', error);
          
          // Handle authentication errors
          if (error instanceof Error && 
              (error.message.includes('proof verify failed') ||
              error.message.includes('Session expired'))) {
            
            if (sessionId) await sessions.delete(sessionId);
            clearSessionCookie(res);
            
            return res.status(401).json({
              error: 'Authentication error: Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          return res.status(500).json({
            error: error instanceof Error ? error.message : 'Transfer failed'
          });
        }

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
    console.error('API error:', err);
    return res.status(500).json({ 
      error: err instanceof Error ? err.message : 'An unexpected error occurred' 
    });
  }
} 
