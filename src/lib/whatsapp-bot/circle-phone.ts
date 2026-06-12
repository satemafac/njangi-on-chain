// circle-phone.ts — circle → linked WhatsApp phone resolution for the
// whatsapp-circle-events cron, ported from the retired bot backend's
// getPhoneNumberForCircle. The legacy bot read a plaintext
// `admin_phone_number` field off the on-chain registry; that field no
// longer exists — the Phase 1 compliance redesign anchors only a Walrus
// blob id on chain, so resolution is now:
//
//   1. Postgres whatsapp_phone_index (circle_id → walrus_blob_id), then
//      decrypt the single matched blob. O(1), covers every link recorded
//      since indexing was enabled. Unavailable for UNLINKED circles —
//      deindexWhatsAppLinksForCircle deletes the rows.
//   2. On-chain registry scan honoring the `enabled` flag (newest link
//      wins), then decrypt. `includeDisabled` lets the unlink
//      confirmation reach the phone of a link that was just disabled.
//
// THROW contract: infra failures (registry object read threw) propagate
// so the cron halts without advancing its cursor; "no link" returns null
// (skip + advance). Per-blob decrypt failures are warned and skipped —
// one corrupt envelope must not wedge the stream.

import type { SuiClient } from '@mysten/sui/client';
import { fetchAndDecryptPII } from '../walrus-pii';
import { lookupBlobsForCircle } from '../whatsapp-link-index';
import { getActiveWhatsAppRegistries } from '../../services/whatsapp-registry-service';
import type { NetworkType } from '../../services/whatsapp-registry-service';
import { appLogger } from '../../utils/logger';

function decodeBytesField(raw: unknown): string {
  if (typeof raw === 'string') {
    return /^[0-9a-fA-F]+$/.test(raw)
      ? Buffer.from(raw, 'hex').toString('utf8')
      : Buffer.from(raw, 'base64').toString('utf8');
  }
  if (Array.isArray(raw)) {
    return new TextDecoder().decode(new Uint8Array(raw as number[]));
  }
  return '';
}

async function decryptPhone(blobId: string, circleId: string): Promise<string | null> {
  try {
    const payload = await fetchAndDecryptPII(blobId);
    return payload.phone_e164 ?? null;
  } catch (err) {
    appLogger.warn('[circle-phone] failed to decrypt PII envelope', {
      circleId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface ResolveCirclePhoneOptions {
  /** Allow a disabled registry link (unlink confirmations). */
  includeDisabled?: boolean;
}

/**
 * Resolves the E.164 phone linked to a circle, or null when no link
 * exists. See the module header for the resolution order and throw
 * contract.
 */
export async function resolveCirclePhone(
  client: SuiClient,
  circleId: string,
  network: NetworkType,
  options: ResolveCirclePhoneOptions = {},
): Promise<string | null> {
  // 1. Postgres index — newest blob first.
  try {
    for (const blobId of await lookupBlobsForCircle(circleId)) {
      const phone = await decryptPhone(blobId, circleId);
      if (phone) return phone;
    }
  } catch (err) {
    appLogger.warn('[circle-phone] index lookup failed; falling back to registry scan', {
      circleId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. On-chain registry scan (current schema: walrus_blob_id only).
  const registries = getActiveWhatsAppRegistries(network);
  const registryId = registries?.[0]?.registryObjectId;
  if (!registryId) return null;

  // Let infra failures here THROW: the caller must halt rather than
  // record a false "no link" and advance past the event.
  const registryObject = await client.getObject({
    id: registryId,
    options: { showContent: true },
  });
  if (!registryObject.data?.content || registryObject.data.content.dataType !== 'moveObject') {
    return null;
  }

  const fields = (registryObject.data.content as { fields: { links?: unknown[] } }).fields;
  const links = Array.isArray(fields?.links) ? fields.links : [];

  type LinkFields = {
    circle_id?: unknown;
    enabled?: unknown;
    walrus_blob_id?: unknown;
  };

  let newestDisabledBlob: string | null = null;

  // Newest link wins (registry appends; duplicates prefer the latest).
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index] as { fields?: LinkFields } & LinkFields;
    const raw = link.fields ?? link;
    if (raw.circle_id !== circleId || !raw.walrus_blob_id) continue;

    const blobId = decodeBytesField(raw.walrus_blob_id);
    if (!blobId) continue;

    if (raw.enabled === true) {
      const phone = await decryptPhone(blobId, circleId);
      if (phone) return phone;
      continue;
    }

    if (options.includeDisabled && newestDisabledBlob === null) {
      newestDisabledBlob = blobId;
    }
  }

  if (options.includeDisabled && newestDisabledBlob) {
    return decryptPhone(newestDisabledBlob, circleId);
  }

  return null;
}

/**
 * Fetches the circle's display name for message copy. Failures fall back
 * to a generic label — the notification is still worth sending.
 */
export async function resolveCircleName(
  client: SuiClient,
  circleId: string,
): Promise<string> {
  try {
    const obj = await client.getObject({ id: circleId, options: { showContent: true } });
    const content = obj.data?.content;
    if (content && content.dataType === 'moveObject') {
      const fields = (content as { fields?: { name?: unknown } }).fields;
      if (typeof fields?.name === 'string' && fields.name.trim() !== '') {
        return fields.name;
      }
    }
  } catch (err) {
    appLogger.warn('[circle-phone] failed to fetch circle name', {
      circleId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return 'Your circle';
}
