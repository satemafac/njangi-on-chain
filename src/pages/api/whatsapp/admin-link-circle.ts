/**
 * Admin Link Circle Endpoint — Phase 1 compliance redesign.
 *
 * The on-chain `whatsapp_integration::link_circle` no longer accepts a
 * plaintext phone or group ID. The PII payload is encrypted server-side,
 * uploaded to Walrus, and only the resulting blob ID + a 32-byte opaque
 * nonce are anchored on chain. The webhook resolution path mirrors this
 * by fetching + decrypting the blob.
 *
 * POST /api/whatsapp/admin-link-circle
 *  body: {
 *    circleId, linkType (1), phoneOrGroup, adminAddress, account, network
 *  }
 *  linkType 2 (a WhatsApp group) is refused with a 400 — see
 *  GROUP_LINKS_UNSUPPORTED.
 *
 * GET /api/whatsapp/admin-link-circle?circleId=...&network=...
 *  returns { isLinked, linkType, walrusBlobId, linkNonceHex,
 *            maskedRecipient?, linkedAt? }
 *  The linked number is decrypted server-side only when
 *  `includeRecipient=true` AND the caller's zkLogin session resolves to the
 *  on-chain circle admin, and even then only a mask leaves the server
 *  (`maskedRecipient`, e.g. "+237 ••• ••• 1234") plus the date the link was
 *  made (`linkedAt`). No response carries the full number. Without that
 *  proof the response carries zero PII (the plain link-existence probe
 *  stays public for the frontend).
 *
 * Auth: POST and the GET `includeRecipient` path require the `session-id`
 * cookie from /api/zkLogin to map to the circle's on-chain admin — see
 * `src/middleware/admin-auth.middleware.ts`. Authorization runs before any
 * side effect (Walrus upload, Postgres index write, chain anchor), and the
 * handler operates on the middleware-verified `req.admin.circleId` /
 * `req.admin.network` so a diverging query string can never retarget the
 * link at a circle the caller does not administer.
 */

import { NextApiResponse, NextApiRequest } from 'next';
import {
  logAdminAction,
  verifyCircleAdminRequest,
  withCircleAdminAuth,
  type AuthenticatedRequest,
} from '../../../middleware/admin-auth.middleware';
import { AccountData } from '../../../services/zkLoginService';
import { getNetworkConfig } from '../../../services/network-config';
import { getActiveWhatsAppRegistries } from '../../../services/whatsapp-registry-service';
import type { NetworkType } from '../../../services/whatsapp-registry-service';
import { getPooledSuiClient } from '../../../services/sui-rpc-failover';
import {
  encryptAndStorePII,
  fetchAndDecryptPII,
  nonceToHex,
  type WhatsAppPiiPayload,
} from '../../../lib/walrus-pii';
import { indexWhatsAppLink, lookupBlobsForCircle } from '../../../lib/whatsapp-link-index';
import { maskPhoneNumber } from '../../../lib/whatsapp-recipient-mask';
import { screenAddress, sanctionsErrorBody } from '../../../lib/sanctions';
import {
  getDriftStatusForAddress,
  addressDriftErrorBody,
} from '../../../lib/zklogin-address-bindings';
import { isEmbargoedHeaders, embargoErrorBody } from '../../../lib/embargo';
import {
  assertEntitled,
  entitlementErrorBody,
  EntitlementError,
} from '../../../lib/entitlement-gate';

interface LinkCircleRequest {
  circleId: string; // consumed by withCircleAdminAuth, not the handler
  linkType: 1 | 2; // 1 = phone number; 2 = WhatsApp group, refused below
  phoneOrGroup: string;
  adminAddress?: string; // must match the session (middleware-enforced)
  account?: AccountData;
  network?: NetworkType; // consumed by withCircleAdminAuth, not the handler
}

// WhatsApp group links (linkType 2) are refused. The Cloud API can message a
// group only if this business number created it through Meta's Groups API
// (Official Business Accounts only, members join by invite link, 8 at most),
// and it addresses that group by the opaque id the Groups API returns. A group
// id copied from the WhatsApp app (…@g.us) can never be messaged, and every
// sender reads only `phone_e164`, so these links received nothing. The
// on-chain registry still accepts LINK_TYPE_GROUP, so a group link made before
// this check can exist; the manage page marks it unsupported.
const GROUP_LINKS_UNSUPPORTED = {
  success: false,
  code: 'WHATSAPP_GROUP_LINKS_UNSUPPORTED',
  error:
    'WhatsApp group links are not supported. WhatsApp only lets a business number ' +
    'message groups it created itself, so a group ID (ending in @g.us) would never ' +
    'receive anything. Link a phone number instead.',
};

function buildPayload(phoneE164: string): WhatsAppPiiPayload {
  return {
    schema_version: 1,
    link_type: 'individual',
    phone_e164: phoneE164,
    created_at: new Date().toISOString(),
  };
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { circleId, network: networkParam, includeRecipient } = req.query;

    if (!circleId || typeof circleId !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing circleId' });
    }

    const network = (networkParam as NetworkType) || 'testnet';

    // PII gate: decrypting the linked recipient requires the caller to prove
    // they are the circle admin (server-verified session + on-chain check).
    // The unauthenticated probe below returns link existence only — no PII.
    const wantsRecipient = includeRecipient === 'true';
    if (wantsRecipient) {
      const verification = await verifyCircleAdminRequest(req, { circleId, network });
      if (!verification.ok) {
        return res
          .status(verification.status)
          .json({ success: false, error: verification.error });
      }
    }

    const activeRegistries = getActiveWhatsAppRegistries(network);
    if (!activeRegistries || activeRegistries.length === 0) {
      throw new Error(`No active WhatsApp registry configured for ${network} network`);
    }
    const registryObjectId = activeRegistries[0].registryObjectId;
    if (!registryObjectId) {
      throw new Error(`WhatsApp registry not configured for ${network} network`);
    }

    const networkConfig = getNetworkConfig(network);
    const suiClient = getPooledSuiClient({ network, rpcUrl: networkConfig.rpcUrl });

    const registryObject = await suiClient.getObject({
      id: registryObjectId,
      options: { showContent: true },
    });

    if (!registryObject.data?.content || !('fields' in registryObject.data.content)) {
      return res
        .status(200)
        .json({ success: true, data: { isLinked: false, message: 'Registry not yet indexed' } });
    }

    const content = registryObject.data.content as Record<string, unknown>;
    const registryFields = content.fields as Record<string, unknown> | undefined;
    if (!registryFields) {
      return res
        .status(200)
        .json({ success: true, data: { isLinked: false, message: 'Registry fields not found' } });
    }

    const links = registryFields.links as unknown[];
    if (!Array.isArray(links)) {
      return res
        .status(200)
        .json({ success: true, data: { isLinked: false, message: 'No links found in registry' } });
    }

    for (const link of links) {
      const linkObj = link as Record<string, unknown>;
      const linkFields = (linkObj.fields as Record<string, unknown>) || linkObj;
      if (!linkFields.circle_id || linkFields.circle_id !== circleId || linkFields.enabled !== true) {
        continue;
      }

      const blobIdRaw = linkFields.walrus_blob_id;
      const nonceRaw = linkFields.link_nonce;
      const linkType = Number(linkFields.link_type ?? 1);

      // Move serializes vector<u8> as either an array of numbers or a base64
      // string depending on indexing settings; normalize to UTF-8 / hex here.
      const walrusBlobId = decodeBytesField(blobIdRaw);
      const linkNonce = decodeBytesField(nonceRaw);
      const walrusBlobIdString = blobIdToString(walrusBlobId);

      // The admin's own card: a mask and a date, never the number.
      const recipientDisplay = wantsRecipient
        ? await readRecipientForDisplay(circleId, walrusBlobIdString)
        : {};

      return res.status(200).json({
        success: true,
        data: {
          isLinked: true,
          linkType,
          walrusBlobId: walrusBlobIdString,
          linkNonceHex: bytesToHex(linkNonce),
          ...recipientDisplay,
        },
      });
    }

    return res
      .status(200)
      .json({ success: true, data: { isLinked: false, message: 'Circle not linked' } });
  } catch (error) {
    console.error('Error querying registry:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to query link status',
    });
  }
}

/** What the admin's WhatsApp card may show about the linked number. */
interface RecipientDisplay {
  /** e.g. "+237 ••• ••• 1234"; see src/lib/whatsapp-recipient-mask.ts. */
  maskedRecipient?: string;
  /** When the link was made (ISO 8601): the card's "Linked on" date. */
  linkedAt?: string;
}

/**
 * Opens the circle's link envelope for the admin's card and returns only
 * what the card may show. The E.164 number never leaves this function: it is
 * masked here, and neither it nor the payload is logged.
 *
 * Blob choice: the circle's rows in the link index (newest first), and the
 * blob anchored on chain only when the index has no row for the circle or
 * cannot be read. /api/cron/walrus-renewal re-stores a blob under a NEW id
 * and records that id only in the index, so the anchored id stops resolving
 * once its first lease ends. resolveMemberPhone (src/lib/whatsapp-notifier.ts)
 * follows the same rule.
 *
 * `linkedAt` is the payload's `created_at`, stamped when the admin submitted
 * the number, seconds before they signed the anchor. Renewal re-seals the
 * same payload, so the date survives it. The on-chain `linked_at` cannot
 * serve: it holds a Sui epoch number, not a time.
 */
async function readRecipientForDisplay(
  circleId: string,
  anchoredBlobId: string,
): Promise<RecipientDisplay> {
  let indexedBlobIds: string[] = [];
  try {
    indexedBlobIds = await lookupBlobsForCircle(circleId);
  } catch (err) {
    console.warn('[admin-link-circle] Link index lookup failed; trying the anchored blob', {
      circleId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const blobIds = (indexedBlobIds.length > 0 ? indexedBlobIds : [anchoredBlobId]).filter(Boolean);
  for (const blobId of blobIds) {
    let payload: WhatsAppPiiPayload;
    try {
      payload = await fetchAndDecryptPII(blobId);
    } catch (err) {
      console.warn('[admin-link-circle] Could not open a link envelope for display', {
        circleId,
        blobId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const createdAtMs = Date.parse(payload.created_at);
    return {
      // Group links carry no phone_e164 and get no mask.
      maskedRecipient: maskPhoneNumber(payload.phone_e164) ?? undefined,
      linkedAt: Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : undefined,
    };
  }

  return {};
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Authorization (session → on-chain admin) runs before the handler so no
  // Walrus upload / index write can happen for an unverified caller.
  return withCircleAdminAuth(handlePost)(req, res);
}

async function handlePost(req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    // Verified by withCircleAdminAuth: session address === on-chain admin.
    // Operate on the circle/network the authorization actually ran against —
    // never re-read them from the raw body, which could diverge from the
    // query string the middleware resolved (cross-circle link hijack).
    const adminAddr = req.admin!.suiAddress;
    const circleId = req.admin!.circleId;
    const network = req.admin!.network;
    // NB: `account` is deliberately not read. The client used to send its
    // ephemeral private key here; nothing in this route may depend on it.

    const { linkType, phoneOrGroup } = req.body as LinkCircleRequest;

    if (!linkType || !phoneOrGroup) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: linkType, phoneOrGroup',
      });
    }

    if (linkType === 2) {
      return res.status(400).json(GROUP_LINKS_UNSUPPORTED);
    }

    if (linkType !== 1) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid linkType (must be 1)' });
    }

    // OFAC screen (docs/sanctions-program.md) — before the Walrus upload
    // and every other side effect.
    if (isEmbargoedHeaders((name) => req.headers[name] as string | undefined)) {
      return res.status(403).json(embargoErrorBody());
    }
    const sanctionsScreen = await screenAddress(adminAddr, 'whatsapp_link');
    if (sanctionsScreen.blocked) {
      logAdminAction('LINK_CIRCLE_SANCTIONS_BLOCKED', adminAddr, { circleId });
      return res.status(403).json(sanctionsErrorBody());
    }

    // Address-drift gate. Linking WhatsApp binds notifications and inbound
    // commands to THIS address; doing that for a drifted identity wires the
    // circle's routing to an account the admin may not realise is new.
    // New commitment -> blocked; fail-open on lookup errors, like the
    // sanctions screen's infrastructure failure mode.
    const driftScreen = await getDriftStatusForAddress(adminAddr);
    if (driftScreen.drifted) {
      logAdminAction('LINK_CIRCLE_ADDRESS_DRIFT_BLOCKED', adminAddr, { circleId });
      return res.status(409).json(addressDriftErrorBody(driftScreen.previousAddresses));
    }

    // Premium gate (ENFORCEABLE): the Walrus PII encryption runs here, and
    // a link is useless without it — the webhook resolves inbound messages
    // through the blob, so anchoring a blob id the server never issued buys
    // nothing. The anchor itself is now signed client-side, so the gate
    // rests on the encryption step alone rather than on holding the key. Runs after admin auth but BEFORE any side
    // effect. No-op while NEXT_PUBLIC_BILLING_ENABLED is off; on billing
    // infra errors it fails open (this is a paid convenience, never an
    // access control on funds).
    try {
      await assertEntitled('whatsappSuite', { userAddress: adminAddr });
    } catch (gateError) {
      if (gateError instanceof EntitlementError) {
        logAdminAction('LINK_CIRCLE_UPGRADE_REQUIRED', adminAddr, {
          circleId,
          feature: gateError.feature,
        });
        return res.status(402).json(entitlementErrorBody(gateError));
      }
      console.warn(
        '[admin-link-circle] Entitlement lookup failed; allowing request (fail-open billing gate):',
        gateError,
      );
    }

    logAdminAction('LINK_CIRCLE_INITIATED', adminAddr, {
      circleId,
      linkType,
      recipient: 'individual',
      network,
    });

    // Confirm step. The browser calls back once the anchor has landed so the
    // webhook index records only links that actually exist on chain — the
    // on-chain link stays the source of truth, and an abandoned signature
    // leaves no phantom route behind.
    //
    // Re-runs admin auth, the sanctions screen and the entitlement gate above
    // (all cheap) but deliberately skips the Walrus upload: the blob was
    // already stored and paid for in the prepare call.
    const { anchoredDigest, walrusBlobId: confirmedBlobId, walrusEndEpoch: confirmedEndEpoch } =
      req.body as {
        anchoredDigest?: string;
        walrusBlobId?: string;
        walrusEndEpoch?: number;
      };
    if (anchoredDigest) {
      if (!confirmedBlobId) {
        return res.status(400).json({
          success: false,
          error: 'anchoredDigest requires the walrusBlobId returned by the prepare call',
        });
      }
      try {
        await indexWhatsAppLink({
          phoneOrGroup,
          circleId,
          walrusBlobId: confirmedBlobId,
          linkType,
          walrusEndEpoch: confirmedEndEpoch,
        });
      } catch (indexError) {
        console.warn('[admin-link-circle] Failed to populate WhatsApp link index', indexError);
      }

      logAdminAction('LINK_CIRCLE_SUCCESS', adminAddr, {
        circleId,
        linkType,
        walrusBlobId: confirmedBlobId,
        txDigest: anchoredDigest,
        status: 'confirmed_on_blockchain',
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'Circle successfully linked to WhatsApp.',
          circleId,
          linkType,
          walrusBlobId: confirmedBlobId,
          txDigest: anchoredDigest,
          status: 'confirmed',
        },
      });
    }

    const activeRegistries = getActiveWhatsAppRegistries(network);
    if (!activeRegistries || activeRegistries.length === 0) {
      throw new Error(`No active WhatsApp registry configured for ${network} network`);
    }

    const whatsappRegistry = activeRegistries[0];
    const packageId = whatsappRegistry.packageId;
    const registryObjectId = whatsappRegistry.registryObjectId;

    if (!packageId || !registryObjectId) {
      throw new Error(`WhatsApp configuration incomplete for ${network} network`);
    }

    // Encrypt the PII payload and upload to Walrus before touching chain so
    // a failed upload aborts the link before consuming gas.
    const payload = buildPayload(phoneOrGroup);
    const { walrusBlobId, linkNonce, walrusEndEpoch } = await encryptAndStorePII(payload);

    // The server's job ends at the Walrus upload. The anchor is signed in
    // the browser (ZkLoginClient.linkCircleToWhatsApp), so the response
    // carries the inputs that transaction needs and nothing else.
    //
    // This used to have a second branch that signed here, using an
    // `ephemeralPrivateKey` the manage page put in the request body. The
    // browser holds that key precisely so the server cannot sign as the
    // user; shipping it back over the wire handed the capability straight
    // back, and with zkProofs + salt + sub + aud alongside it the server
    // could have signed ANY transaction for that address until the epoch
    // rolled. Deleted, not gated.
    logAdminAction('LINK_CIRCLE_PREPARED', adminAddr, {
      circleId,
      linkType,
      walrusBlobId,
      linkNonceHex: nonceToHex(linkNonce),
      status: 'awaiting_client_signature',
    });

    return res.status(200).json({
      success: true,
      data: {
        message:
          'PII encrypted and stored in Walrus. Sign the on-chain anchor to finish linking.',
        circleId,
        linkType,
        walrusBlobId,
        linkNonceHex: nonceToHex(linkNonce),
        walrusEndEpoch,
        // Anchor inputs — the browser must not have to guess which registry
        // generation is live.
        packageId,
        registryObjectId,
        status: 'pending',
      },
    });
  } catch (error) {
    const suiAddress = req.admin?.suiAddress;
    if (suiAddress) {
      logAdminAction('LINK_CIRCLE_ERROR', suiAddress, {
        error: error instanceof Error ? error.message : String(error),
        circleId: req.body?.circleId,
      });
    }

    console.error('Admin link circle error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to link circle',
    });
  }
}

function decodeBytesField(raw: unknown): Uint8Array {
  if (!raw) return new Uint8Array();
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]);
  if (typeof raw === 'string') {
    return /^[0-9a-fA-F]+$/.test(raw)
      ? new Uint8Array(Buffer.from(raw, 'hex'))
      : new Uint8Array(Buffer.from(raw, 'base64'));
  }
  return new Uint8Array();
}

function blobIdToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export default handler;
