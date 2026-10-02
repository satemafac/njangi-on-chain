/**
 * scripts/validate-env.mjs checked the active network's object ids for
 * presence only, so .env.example's `0xyour_…` placeholders passed it. It must
 * now reject them for the ACTIVE network, and still leave the other
 * network's placeholders alone: testnet pilots keep the mainnet ones until
 * mainnet is published.
 *
 * Runs the script itself (it makes no network calls) on copies of
 * .env.example, and asserts only on the object-id errors: a template copy
 * fails other checks too.
 */
import { spawnSync } from 'child_process';
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
