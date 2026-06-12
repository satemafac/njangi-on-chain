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
 *    circleId, linkType (1|2), phoneOrGroup, adminAddress, account, network
 *  }
 *
 * GET /api/whatsapp/admin-link-circle?circleId=...&network=...
 *  returns { isLinked, linkType, walrusBlobId, linkNonceHex, recipient? }
 *  `recipient` is decrypted server-side and only returned when
 *  `includeRecipient=true` AND the caller's zkLogin session resolves to the
 *  on-chain circle admin. Without that proof the response carries zero PII
 *  (the plain link-existence probe stays public for the frontend).
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
import { enokiZkLoginService } from '../../../services/enokiZkLoginService';
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
import { indexWhatsAppLink } from '../../../lib/whatsapp-link-index';

interface LinkCircleRequest {
  circleId: string; // consumed by withCircleAdminAuth, not the handler
  linkType: 1 | 2; // 1 = individual, 2 = group
  phoneOrGroup: string;
  groupName?: string;
  adminAddress?: string; // must match the session (middleware-enforced)
  account?: AccountData;
  network?: NetworkType; // consumed by withCircleAdminAuth, not the handler
}

function buildPayload(
  linkType: 1 | 2,
  phoneOrGroup: string,
  groupName?: string,
): WhatsAppPiiPayload {
  const base: WhatsAppPiiPayload = {
    schema_version: 1,
    link_type: linkType === 1 ? 'individual' : 'group',
    created_at: new Date().toISOString(),
  };
  if (linkType === 1) {
    base.phone_e164 = phoneOrGroup;
  } else {
    base.group_id = phoneOrGroup;
    if (groupName) base.group_name = groupName;
  }
  return base;
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

      let recipient: string | undefined;
      if (wantsRecipient) {
        try {
          const payload = await fetchAndDecryptPII(walrusBlobIdString);
          recipient = payload.phone_e164 ?? payload.group_id ?? undefined;
        } catch (err) {
          console.warn('[admin-link-circle] Failed to decrypt PII envelope:', err);
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          isLinked: true,
          linkType,
          walrusBlobId: walrusBlobIdString,
          linkNonceHex: bytesToHex(linkNonce),
          recipient,
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
    const account = req.body?.account as AccountData | undefined;

    const { linkType, phoneOrGroup, groupName } = req.body as LinkCircleRequest;

    if (!linkType || !phoneOrGroup) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: linkType, phoneOrGroup',
      });
    }

    if (![1, 2].includes(linkType)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid linkType (must be 1 or 2)' });
    }

    logAdminAction('LINK_CIRCLE_INITIATED', adminAddr, {
      circleId,
      linkType,
      recipient: linkType === 1 ? 'individual' : 'group',
      network,
    });

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
    const payload = buildPayload(linkType, phoneOrGroup, groupName);
    const { walrusBlobId, linkNonce } = await encryptAndStorePII(payload);

    if (!account || !account.zkProofs) {
      logAdminAction('LINK_CIRCLE_SUCCESS', adminAddr, {
        circleId,
        linkType,
        walrusBlobId,
        linkNonceHex: nonceToHex(linkNonce),
        status: 'pending_blockchain_confirmation',
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'PII encrypted and stored in Walrus. Submit the on-chain anchor from a signed session.',
          circleId,
          linkType,
          walrusBlobId,
          linkNonceHex: nonceToHex(linkNonce),
          status: 'pending',
        },
      });
    }

    const networkConfig = getNetworkConfig(network);
    console.log(`[admin-link-circle] Anchoring blob ${walrusBlobId} for circle ${circleId} on ${network} (${networkConfig.rpcUrl})`);

    const blobIdBytes = Array.from(new TextEncoder().encode(walrusBlobId));
    const nonceBytes = Array.from(linkNonce);

    const result = await enokiZkLoginService.sendTransaction(
      account,
      (txb) => {
        txb.moveCall({
          target: `${packageId}::whatsapp_integration::link_circle`,
          arguments: [
            txb.object(registryObjectId),
            txb.pure.address(circleId),
            txb.pure.u8(linkType),
            txb.pure.vector('u8', blobIdBytes),
            txb.pure.vector('u8', nonceBytes),
            txb.pure.address(adminAddr || account.userAddr),
          ],
        });
      },
      { gasBudget: 10_000_000 },
      network as 'testnet' | 'mainnet',
    );

    // Phase 2: index the (HMAC(phone), circle_id, blob_id) tuple so the
    // webhook can resolve incoming messages in O(1). Failures are logged
    // but non-fatal — the on-chain link is the source of truth, and the
    // webhook will fall back to the legacy O(N) Walrus scan if the index
    // is missing or stale.
    try {
      await indexWhatsAppLink({
        phoneOrGroup,
        circleId,
        walrusBlobId,
        linkType,
      });
    } catch (indexError) {
      console.warn('[admin-link-circle] Failed to populate WhatsApp link index', indexError);
    }

    logAdminAction('LINK_CIRCLE_SUCCESS', adminAddr, {
      circleId,
      linkType,
      walrusBlobId,
      linkNonceHex: nonceToHex(linkNonce),
      txDigest: result.digest,
      status: 'confirmed_on_blockchain',
    });

    return res.status(200).json({
      success: true,
      data: {
        message: 'Circle successfully linked to WhatsApp; PII stored encrypted in Walrus.',
        circleId,
        linkType,
        walrusBlobId,
        linkNonceHex: nonceToHex(linkNonce),
        txDigest: result.digest,
        status: 'confirmed',
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
