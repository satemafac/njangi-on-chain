/**
 * scripts/validate-env.mjs checked the active network's object ids for
 * presence only, so .env.example's `0xyour_…` placeholders passed it. It must
 * now reject them for the ACTIVE network, and still leave the other
 * network's placeholders alone: testnet pilots keep the mainnet ones until
 * mainnet is published.
 *
 * Runs the script itself (it makes no network calls) on copies of
 * .env.example, and asserts only on the errors each test is about: a
 * template copy fails other checks too.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const template = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

const ID_SUFFIXES = [
  'PACKAGE_ID',
  'WHATSAPP_PACKAGE_ID',
  'WHATSAPP_REGISTRY_ID',
  'NJANGI_ATTESTOR_CAP_ID',
  'NJANGI_ASSET_REGISTRY_ID',
];
const REAL_ID = '0xeda9982219bd3c0c2506f8ae753a28a228b5e62c04aaebc6c8a906477433be21';

function validate(env: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'validate-env-'));
  const file = path.join(dir, '.env.local');
  try {
    writeFileSync(file, env);
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/validate-env.mjs'), file], {
      encoding: 'utf8',
    });
    return result.stderr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setVar(env: string, key: string, value: string): string {
  return env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
}

const objectIdErrors = (stderr: string) => stderr.split('\n').filter((line) => line.includes('not an object id'));

describe('validate-env object ids', () => {
  it('rejects every testnet placeholder when testnet is active, and no mainnet one', () => {
    const errors = objectIdErrors(validate(template));

    for (const suffix of ID_SUFFIXES) {
      const key = `NEXT_PUBLIC_TESTNET_${suffix}`;
      expect(errors).toContainEqual(expect.stringContaining(`${key} is "0xyour_testnet_`));
    }
    expect(errors).toHaveLength(ID_SUFFIXES.length);
    expect(errors.join('\n')).not.toContain('MAINNET');
  });

  it('rejects the mainnet placeholders when mainnet is active, and no testnet one', () => {
    const errors = objectIdErrors(validate(setVar(template, 'NEXT_PUBLIC_SUI_NETWORK', 'mainnet')));

    for (const suffix of ID_SUFFIXES) {
      expect(errors).toContainEqual(expect.stringContaining(`NEXT_PUBLIC_MAINNET_${suffix} is "0xyour_mainnet_`));
    }
    expect(errors).toHaveLength(ID_SUFFIXES.length);
    expect(errors.join('\n')).not.toContain('TESTNET');
  });

  it('accepts real ids for the active network', () => {
    let env = template;
    for (const suffix of ID_SUFFIXES) env = setVar(env, `NEXT_PUBLIC_TESTNET_${suffix}`, REAL_ID);
    // Short ids are ids too (0x6 is the Clock).
    env = setVar(env, 'NEXT_PUBLIC_TESTNET_NJANGI_ATTESTOR_CAP_ID', '0x6');

    expect(objectIdErrors(validate(env))).toEqual([]);
  });
});

// WALRUS_PII_PREVIOUS_MASTER_KEY is set only while WALRUS_PII_MASTER_KEY is
// being rotated (docs/environment.md). The script must catch the mistakes
// that would leave stored WhatsApp links unreadable, and never print a key.
describe('validate-env WhatsApp PII keys', () => {
  const OLD_KEY = randomBytes(32).toString('hex');
  const NEW_KEY = randomBytes(32).toString('hex');
  const piiKeyErrors = (stderr: string) => stderr.split('\n').filter((line) => line.includes('WALRUS_PII'));
  const withKeys = (master: string, previous: string) =>
    setVar(setVar(template, 'WALRUS_PII_MASTER_KEY', master), 'WALRUS_PII_PREVIOUS_MASTER_KEY', previous);

  it('accepts a master key with no previous key', () => {
    expect(piiKeyErrors(validate(withKeys(NEW_KEY, '')))).toEqual([]);
  });

  it('accepts a rotation: the old key as previous, the new one as master', () => {
    expect(piiKeyErrors(validate(withKeys(NEW_KEY, OLD_KEY)))).toEqual([]);
  });

  it('rejects a master key that is not 32 bytes, such as the template placeholder', () => {
    expect(piiKeyErrors(validate(template))).toEqual([
      expect.stringContaining('WALRUS_PII_MASTER_KEY must decode to exactly 32 bytes'),
    ]);
  });

  it('rejects a previous key that is not 32 bytes, without printing it', () => {
    const shortKey = randomBytes(16).toString('hex');
    const errors = piiKeyErrors(validate(withKeys(NEW_KEY, shortKey)));

    expect(errors).toEqual([
      expect.stringContaining('WALRUS_PII_PREVIOUS_MASTER_KEY must decode to exactly 32 bytes'),
    ]);
    expect(errors.join('\n')).not.toContain(shortKey);
  });

  it('rejects a previous key that is the master key, even in another encoding', () => {
    const sameKeyBase64 = Buffer.from(NEW_KEY, 'hex').toString('base64');
    const errors = piiKeyErrors(validate(withKeys(NEW_KEY, sameKeyBase64)));

    expect(errors).toEqual([expect.stringContaining('is the same key as WALRUS_PII_MASTER_KEY')]);
    expect(errors.join('\n')).not.toContain(NEW_KEY);
  });

  it('rejects a previous key without a master key', () => {
    expect(piiKeyErrors(validate(withKeys('', OLD_KEY)))).toEqual([
      expect.stringContaining('WALRUS_PII_MASTER_KEY is empty'),
    ]);
  });
});

// Only the WhatsApp values the app reads are required. The webhook callback
// URL is set in Meta's App Dashboard, the business account id matters only in
// WhatsApp Manager, and the Graph API version is a constant in
// src/lib/whatsapp-graph-api.ts, never an env var.
describe('validate-env WhatsApp variables', () => {
  const REQUIRED = ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET'];
  // A word boundary, so NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID doesn't count.
  const whatsappLines = (stderr: string) => stderr.split('\n').filter((line) => /\bWHATSAPP_/.test(line));

  it('requires the four values the app reads', () => {
    let env = template;
    for (const key of REQUIRED) env = setVar(env, key, '');

    expect(whatsappLines(validate(env))).toEqual(
      REQUIRED.map((key) => expect.stringContaining(`Missing required variable: ${key}`)),
    );
  });

  it('requires neither the webhook URL nor the business account id', () => {
    const env = `${setVar(template, 'WHATSAPP_BUSINESS_ACCOUNT_ID', '')}\nWHATSAPP_WEBHOOK_URL=\n`;

    expect(whatsappLines(validate(env))).toEqual([]);
  });

  it('warns while a retired variable is still set', () => {
    const env = `${template}\nWHATSAPP_API_VERSION=v21.0\nWHATSAPP_WEBHOOK_URL=https://njangionchain.com/api/whatsapp/webhook\n`;

    expect(whatsappLines(validate(env))).toEqual([
      expect.stringContaining('WHATSAPP_API_VERSION is set but unused'),
      expect.stringContaining('WHATSAPP_WEBHOOK_URL is set but unused'),
    ]);
  });
});
