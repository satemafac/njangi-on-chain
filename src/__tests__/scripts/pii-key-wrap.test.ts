/**
 * scripts/lib/pii-key-wrap.ts: wrapping per-link data keys under the master
 * key (the app's src/lib/whatsapp-pii-keys.ts and the rotation script
 * scripts/rewrap-whatsapp-pii-keys.mjs share it). A wrap must open only
 * under the key that made it and only for its own key id, and a rotation
 * must re-wrap without changing the data key.
 */
import { randomBytes } from 'crypto';
import {
  PII_KEY_BYTES,
  decodePiiMasterKey,
  isKeyId,
  kekIdOf,
  kekOf,
  newDataKey,
  newKeyId,
  planRewrap,
  unwrapDataKey,
  unwrapWithRing,
  wrapDataKey,
} from '../../../scripts/lib/pii-key-wrap';

const oldKek = kekOf(randomBytes(32));
const newKek = kekOf(randomBytes(32));

function wrappedRow(dek: Buffer, kek = oldKek) {
  const kid = newKeyId();
  return { kid, wrapped_dek: wrapDataKey(dek, kek.key, kid), kek_id: kek.id };
}

describe('decodePiiMasterKey', () => {
  it('reads 64 hex digits as hex and anything else as base64, like the app always has', () => {
    const key = randomBytes(32);
    expect(decodePiiMasterKey('K', key.toString('hex')).equals(key)).toBe(true);
    expect(decodePiiMasterKey('K', key.toString('base64')).equals(key)).toBe(true);
  });

  it('refuses a key that is not 32 bytes, naming the variable but not the value', () => {
    expect(() => decodePiiMasterKey('WALRUS_PII_MASTER_KEY', 'c2hvcnQ=')).toThrow(
      'WALRUS_PII_MASTER_KEY must decode to exactly 32 bytes (got 5).',
    );
  });
});

describe('key ids and KEK ids', () => {
  it('gives every key a fresh 32-hex-digit id', () => {
    const a = newKeyId();
    expect(isKeyId(a)).toBe(true);
    expect(newKeyId()).not.toBe(a);
    expect(isKeyId('not-a-kid')).toBe(false);
    expect(isKeyId('AB'.repeat(16))).toBe(false);
    expect(isKeyId(undefined)).toBe(false);
  });

  it('names a KEK by a stable 16-hex-digit id that differs between keys and is not the key', () => {
    const key = randomBytes(32);
    expect(kekIdOf(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(kekIdOf(key)).toBe(kekIdOf(Buffer.from(key)));
    expect(kekIdOf(randomBytes(32))).not.toBe(kekIdOf(key));
    expect(key.toString('hex')).not.toContain(kekIdOf(key));
  });

  it('makes 32-byte data keys', () => {
    expect(newDataKey()).toHaveLength(PII_KEY_BYTES);
  });
});

describe('wrapDataKey / unwrapDataKey', () => {
  it('round-trips under the same KEK and key id', () => {
    const dek = newDataKey();
    const kid = newKeyId();
    const wrapped = wrapDataKey(dek, oldKek.key, kid);
    expect(unwrapDataKey(wrapped, oldKek.key, kid)?.equals(dek)).toBe(true);
    // Fresh IV every time.
    expect(wrapDataKey(dek, oldKek.key, kid)).not.toBe(wrapped);
  });

  it('does not open under another KEK, for another key id, or once altered', () => {
    const dek = newDataKey();
    const kid = newKeyId();
    const wrapped = wrapDataKey(dek, oldKek.key, kid);
    expect(unwrapDataKey(wrapped, newKek.key, kid)).toBeNull();
    expect(unwrapDataKey(wrapped, oldKek.key, newKeyId())).toBeNull();
    const altered = Buffer.from(wrapped, 'base64');
    altered[20] ^= 0x01;
    expect(unwrapDataKey(altered.toString('base64'), oldKek.key, kid)).toBeNull();
  });

  it('refuses a stored value of the wrong length, and a data key of the wrong length', () => {
    expect(() => unwrapDataKey(Buffer.alloc(10).toString('base64'), oldKek.key, newKeyId())).toThrow(
      /is 10 bytes, not 60/,
    );
    expect(() => wrapDataKey(randomBytes(16), oldKek.key, newKeyId())).toThrow(/must be 32 bytes/);
  });
});

describe('unwrapWithRing', () => {
  it('unwraps with the key its kek_id names: current or, during a rotation, previous', () => {
    const dek = newDataKey();
    const onOld = wrappedRow(dek, oldKek);
    const onNew = wrappedRow(dek, newKek);
    const ring = { current: newKek, previous: oldKek };

    expect(unwrapWithRing(onNew, ring)).toEqual({ ok: true, dek, kek: 'current' });
    expect(unwrapWithRing(onOld, ring)).toEqual({ ok: true, dek, kek: 'previous' });
  });

  it('says unknown_kek when neither key wrapped it, and corrupt when the named key does not open it', () => {
    const row = wrappedRow(newDataKey(), oldKek);
    expect(unwrapWithRing(row, { current: newKek, previous: null })).toEqual({
      ok: false,
      reason: 'unknown_kek',
    });
    expect(unwrapWithRing({ ...row, wrapped_dek: 'not base64 at all' }, { current: oldKek, previous: null })).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    const swapped = { ...row, kid: newKeyId() };
    expect(unwrapWithRing(swapped, { current: oldKek, previous: null })).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });
});

describe('planRewrap', () => {
  it('re-wraps a key from the previous KEK under the current one, keeping the data key', () => {
    const dek = newDataKey();
    const row = wrappedRow(dek, oldKek);
    const plan = planRewrap(row, { current: newKek, previous: oldKek });

    expect(plan.action).toBe('rewrap');
    if (plan.action !== 'rewrap') return;
    expect(plan.kekId).toBe(newKek.id);
    expect(unwrapDataKey(plan.wrappedDek, newKek.key, row.kid)?.equals(dek)).toBe(true);
    expect(unwrapDataKey(plan.wrappedDek, oldKek.key, row.kid)).toBeNull();
  });

  it('keeps a key already under the current KEK, and reports one it cannot open', () => {
    const ring = { current: newKek, previous: oldKek };
    expect(planRewrap(wrappedRow(newDataKey(), newKek), ring)).toEqual({ action: 'keep' });
    expect(planRewrap(wrappedRow(newDataKey(), kekOf(randomBytes(32))), ring)).toEqual({
      action: 'unknown_kek',
    });
    const altered = wrappedRow(newDataKey(), oldKek);
    expect(planRewrap({ ...altered, kid: newKeyId() }, ring)).toEqual({ action: 'corrupt' });
  });
});
