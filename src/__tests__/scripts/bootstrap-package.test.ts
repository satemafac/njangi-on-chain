/**
 * Runs scripts/bootstrap-package.mjs itself, end to end, without a network or
 * a key: a local stub answers its JSON-RPC reads, and a fake `sui` records
 * every CLI call and prints canned `--json`. The child gets PATH = the fake
 * plus /usr/bin:/bin (the real CLI lives in ~/.local/bin), a scratch HOME,
 * and the stub's URL, so it cannot reach a real keystore or RPC.
 *
 * These pin the ComplianceConfig step: keep a live config, record the one the
 * lineage already has (never a second one), create one only on a lineage
 * without any, and sign nothing when a read fails.
 *
 * Package, UpgradeCap, deployer and WhatsApp registry ids are real testnet
 * values (read 2026-10-03); the other ids are made up.
 */
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { normalizeSuiId, publishedValue } from '../../../scripts/lib/registry-bootstrap';

const repoRoot = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(repoRoot, 'scripts/bootstrap-package.mjs');

const ORIGINAL = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const V9 = '0xf8afd3dfcf94f152ec9d1f8cb870b77525353a20564bb0224bcad5520d621614';
const DEPLOYER = '0xdde1086c98c6023db8e3d8267992e4c9aeba3d0271f6bac85dc2f6daa8301c77';
const UPGRADE_CAP = '0xc590f7b3ad86a637d2a85100703417b1a918dd02d64ebdc2c8413d0d179a7cb4';
const WA_REGISTRY = '0xeda9982219bd3c0c2506f8ae753a28a228b5e62c04aaebc6c8a906477433be21';
const ASSET_REGISTRY = `0x${'a5'.repeat(32)}`;
const ATTESTOR_CAP = `0x${'ac'.repeat(32)}`;
const TESTNET_CONFIG = `0x${'c0'.repeat(32)}`;
/** A package published just now, and the config its init shared. */
const FRESH = `0x${'a1'.repeat(32)}`;
const FRESH_CONFIG = `0x${'c1'.repeat(32)}`;
/** An upgrade that added njangi_compliance (init never ran), and the config create_config makes. */
const UPGRADED = `0x${'b2'.repeat(32)}`;
const NEW_CONFIG = `0x${'c2'.repeat(32)}`;
const OTHER = `0x${'f6'.repeat(32)}`;

const SHARED = { Shared: { initial_shared_version: 406633527 } };
const KEYS = {
  wa: 'NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID',
  asset: 'NEXT_PUBLIC_TESTNET_NJANGI_ASSET_REGISTRY_ID',
  config: 'NEXT_PUBLIC_TESTNET_NJANGI_COMPLIANCE_CONFIG_ID',
  cap: 'NEXT_PUBLIC_TESTNET_NJANGI_ATTESTOR_CAP_ID',
  issuer: 'NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER',
};

const type = (pkg: string, module: string, name: string) => `${pkg}::${module}::${name}`;
const types = (pkg: string) => ({
  wa: type(pkg, 'whatsapp_integration', 'WhatsAppLinksRegistry'),
  asset: type(pkg, 'njangi_price_validator', 'AssetRegistry'),
  cap: type(pkg, 'njangi_compliance', 'AttestorCap'),
  config: type(pkg, 'njangi_compliance', 'ComplianceConfig'),
  createdEvent: type(pkg, 'njangi_compliance', 'ComplianceConfigCreated'),
});

/** A package whose type origin table names `declaredBy` for every bootstrap type. */
function packageObject(id: string, declaredBy: string, createdBy: string) {
  const rows = [
    ['whatsapp_integration', 'WhatsAppLinksRegistry'],
    ['njangi_price_validator', 'AssetRegistry'],
    ['njangi_compliance', 'AttestorCap'],
    ['njangi_compliance', 'ComplianceConfig'],
    ['njangi_compliance', 'ComplianceConfigCreated'],
  ].map(([module_name, datatype_name]) => ({ module_name, datatype_name, package: declaredBy }));
  return {
    data: {
      objectId: id,
      type: 'package',
      owner: 'Immutable',
      previousTransaction: createdBy,
      bcs: { dataType: 'package', id, typeOriginTable: rows },
    },
  };
}
const sharedObject = (id: string, objectType: string) => ({ data: { objectId: id, type: objectType, owner: SHARED } });
const created = (objectId: string, owner: unknown) => ({ owner, reference: { objectId, version: '1', digest: 'x' } });
function upgradeCap(owner: string, pkg: string) {
  return {
    data: {
      objectId: UPGRADE_CAP,
      type: '0x2::package::UpgradeCap',
      owner: { AddressOwner: owner },
      content: { dataType: 'moveObject', fields: { id: { id: UPGRADE_CAP }, package: pkg, policy: 0, version: '2' } },
    },
  };
}

interface Chain {
  objects: Record<string, unknown>;
  transactions?: Record<string, unknown>;
  events?: Record<string, unknown[]>;
  /** Struct types each address owns, for the AttestorCap lookup. */
  owned?: Record<string, { objectId: string; type: string }[]>;
  /** `method` or `method:<first param>` → an HTTP status or a JSON-RPC error. */
  fail?: Record<string, { status: number } | { error: { code: number; message: string } }>;
}

/** The live testnet lineage, bootstrapped with the v9 id: every id already in place. */
const testnet: Chain = {
  objects: {
    [V9]: packageObject(V9, ORIGINAL, 'Ap9Xpvx2vyKtiPiEGT7QxJ63ieJ2FPzKKzY1b6ymEPhx'),
    [ORIGINAL]: packageObject(ORIGINAL, ORIGINAL, '4QJj9JMDMBs5mUtvQwMXpFEbh3AigXJ5ZxAeXTRb25jt'),
    [WA_REGISTRY]: sharedObject(WA_REGISTRY, types(ORIGINAL).wa),
    [ASSET_REGISTRY]: sharedObject(ASSET_REGISTRY, types(ORIGINAL).asset),
    [TESTNET_CONFIG]: sharedObject(TESTNET_CONFIG, types(ORIGINAL).config),
  },
  // publicnode has pruned both transactions: none is served.
  owned: { [DEPLOYER]: [{ objectId: ATTESTOR_CAP, type: types(ORIGINAL).cap }] },
};

/** FRESH right after `sui client publish`: init shared FRESH_CONFIG in the publish. */
const freshPublish: Chain = {
  objects: {
    [FRESH]: packageObject(FRESH, FRESH, 'FreshPublishTx'),
    [FRESH_CONFIG]: sharedObject(FRESH_CONFIG, types(FRESH).config),
  },
  transactions: {
    FreshPublishTx: {
      digest: 'FreshPublishTx',
      effects: {
        status: { status: 'success' },
        created: [
          created(FRESH, 'Immutable'),
          created(UPGRADE_CAP, { AddressOwner: DEPLOYER }),
          created(ATTESTOR_CAP, { AddressOwner: DEPLOYER }),
          created(FRESH_CONFIG, SHARED),
        ],
      },
    },
  },
  owned: { [DEPLOYER]: [{ objectId: ATTESTOR_CAP, type: types(FRESH).cap }] },
};

/** UPGRADED right after `sui client upgrade` added njangi_compliance: no config, no event. */
const upgradeWithoutConfig: Chain = {
  objects: {
    [UPGRADED]: packageObject(UPGRADED, UPGRADED, 'UpgradeTx'),
    [WA_REGISTRY]: sharedObject(WA_REGISTRY, types(UPGRADED).wa),
    [ASSET_REGISTRY]: sharedObject(ASSET_REGISTRY, types(UPGRADED).asset),
    [UPGRADE_CAP]: upgradeCap(DEPLOYER, UPGRADED),
  },
  transactions: {
    UpgradeTx: { digest: 'UpgradeTx', effects: { status: { status: 'success' }, created: [created(UPGRADED, 'Immutable')] } },
  },
};

const PRUNED_TX = (digest: string) => ({
  error: { code: -32602, message: `Could not find the referenced transaction [TransactionDigest(${digest})].` },
});

let chain: Chain = testnet;
let rpcLog: { method: string; params: unknown[] }[] = [];
let rpcUrl = '';
let server: http.Server;

function answer(method: string, params: unknown[]): { status?: number; body?: Record<string, unknown> } {
  const first = params[0];
  const failure = chain.fail?.[`${method}:${typeof first === 'string' ? first : ''}`] ?? chain.fail?.[method];
  if (failure) return 'status' in failure ? { status: failure.status } : { body: failure };
  const missing = (id: string) => ({ error: { code: 'notExists', object_id: id } });
  const object = (id: string) => chain.objects[normalizeSuiId(id)] ?? missing(id);
  switch (method) {
    case 'sui_getObject':
      return { body: { result: object(first as string) } };
    case 'sui_multiGetObjects':
      return { body: { result: (first as string[]).map(object) } };
    case 'sui_getTransactionBlock': {
      const tx = chain.transactions?.[first as string];
      return { body: tx ? { result: tx } : PRUNED_TX(first as string) };
    }
    case 'suix_queryEvents': {
      const eventType = (first as { MoveEventType: string }).MoveEventType;
      return { body: { result: { data: chain.events?.[eventType] ?? [], nextCursor: null, hasNextPage: false } } };
    }
    case 'suix_getOwnedObjects': {
      const structType = (params[1] as { filter: { StructType: string } }).filter.StructType;
      const owned = (chain.owned?.[normalizeSuiId(first as string)] ?? []).filter((item) => item.type === structType);
      return {
        body: {
          result: { data: owned.map(({ objectId }) => ({ data: { objectId } })), nextCursor: null, hasNextPage: false },
        },
      };
    }
    default:
      return { body: { error: { code: -32601, message: `stub: no ${method}` } } };
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(raw);
      rpcLog.push({ method, params });
      const { status, body } = answer(method, params);
      res.writeHead(status ?? 200, { 'content-type': 'application/json' });
      res.end(body ? JSON.stringify({ jsonrpc: '2.0', id, ...body }) : '');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bootstrap-package-'));
  rpcLog = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The fake `sui`: records argv, answers `client active-address`, and answers
 * `client call` from `calls`, keyed `module::function`.
 */
const FAKE_SUI = `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SUI_LOG, JSON.stringify(args) + '\\n');
const { address, calls } = JSON.parse(fs.readFileSync(process.env.FAKE_SUI_ANSWERS, 'utf8'));
const target = args[args.indexOf('--module') + 1] + '::' + args[args.indexOf('--function') + 1];
if (args[0] === 'client' && args[1] === 'active-address') {
  process.stdout.write(address + '\\n');
} else if (args[0] === 'client' && args[1] === 'call' && calls[target]) {
  process.stdout.write(JSON.stringify(calls[target]));
} else {
  process.stderr.write('fake sui: unexpected ' + args.join(' ') + '\\n');
  process.exit(1);
}
`;

/** `sui client call --json` output for a call that shared one object. */
function callOutput(objectId: string, objectType: string) {
  return {
    effects: { status: { status: 'success' }, created: [created(objectId, SHARED)] },
    objectChanges: [{ type: 'created', owner: SHARED, objectType, objectId }],
  };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  env: string;
  suiCalls: string[][];
}

async function bootstrap(
  packageId: string,
  envFile: string,
  options: { calls?: Record<string, unknown>; env?: Record<string, string> } = {},
): Promise<Run> {
  const bin = path.join(dir, 'bin');
  const recorder = path.join(dir, 'fake-sui.cjs');
  const log = path.join(dir, 'sui-calls.log');
  const answers = path.join(dir, 'sui-answers.json');
  const env = path.join(dir, '.env.local');
  mkdirSync(bin);
  writeFileSync(recorder, FAKE_SUI);
  writeFileSync(path.join(bin, 'sui'), `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`);
  chmodSync(path.join(bin, 'sui'), 0o755);
  writeFileSync(answers, JSON.stringify({ address: DEPLOYER, calls: options.calls ?? {} }));
  writeFileSync(env, envFile);

  // Asynchronous on purpose: spawnSync would block the in-process stub.
  const child = spawn(process.execPath, [SCRIPT, packageId], {
    cwd: dir,
    env: {
      NODE_ENV: 'test',
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      NJANGI_BOOTSTRAP_NETWORK: 'testnet',
      NJANGI_BOOTSTRAP_ENV_FILE: env,
      NJANGI_BOOTSTRAP_RPC_URL: rpcUrl,
      FAKE_SUI_LOG: log,
      FAKE_SUI_ANSWERS: answers,
      ...options.env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((done) => child.on('close', done));
  const suiCalls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
    : [];
  return { code, stdout, stderr, env: readFileSync(env, 'utf8'), suiCalls };
}

const signed = (run: Run) => run.suiCalls.filter((args) => args[1] === 'call');
const functionOf = (args: string[]) => args[args.indexOf('--function') + 1];
const envFile = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n';

jest.setTimeout(30_000);

describe('bootstrap-package.mjs ComplianceConfig step', () => {
  it('keeps a live config and the live registries, and signs nothing', async () => {
    chain = testnet;
    const before = envFile({ [KEYS.wa]: WA_REGISTRY, [KEYS.asset]: ASSET_REGISTRY, [KEYS.config]: TESTNET_CONFIG });

    const run = await bootstrap(V9, before);

    expect(run.code).toBe(0);
    expect(signed(run)).toEqual([]);
    expect(dotenv.parse(run.env)).toEqual({
      [KEYS.wa]: WA_REGISTRY,
      [KEYS.asset]: ASSET_REGISTRY,
      [KEYS.config]: TESTNET_CONFIG,
      [KEYS.cap]: ATTESTOR_CAP,
      [KEYS.issuer]: DEPLOYER,
    });
    expect(run.stdout).toContain(`${KEYS.config}=${TESTNET_CONFIG} is a live ${types(ORIGINAL).config}; keeping it`);
  });

  it('records the config init shared on a fresh publish instead of creating a second one', async () => {
    chain = freshPublish;
    const template = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

    const run = await bootstrap(FRESH, template, {
      calls: {
        'whatsapp_integration::init_registry': callOutput(`0x${'e1'.repeat(32)}`, types(FRESH).wa),
        'njangi_price_validator::init_registry': callOutput(`0x${'e2'.repeat(32)}`, types(FRESH).asset),
      },
    });

    expect(run.code).toBe(0);
    expect(signed(run).map(functionOf)).toEqual(['init_registry', 'init_registry']);
    const after = dotenv.parse(run.env);
    expect(after[KEYS.config]).toBe(FRESH_CONFIG);
    expect(after[KEYS.wa]).toBe(`0x${'e1'.repeat(32)}`);
    expect(after[KEYS.asset]).toBe(`0x${'e2'.repeat(32)}`);
    expect(after[KEYS.cap]).toBe(ATTESTOR_CAP);
    expect(run.stdout).toContain(`was created when ${FRESH} was published; recorded ${FRESH_CONFIG}`);
    expect(rpcLog.map(({ method }) => method)).not.toContain('suix_queryEvents');
  });

  it.each([
    ['unset', {}],
    ['a placeholder', { [KEYS.config]: '0xyour_testnet_compliance_config_id' }],
    ['an object of another type', { [KEYS.config]: ASSET_REGISTRY }],
  ])('creates the config on a lineage that has none when the variable is %s', async (_label, configLine) => {
    chain = upgradeWithoutConfig;

    const run = await bootstrap(UPGRADED, envFile({ [KEYS.wa]: WA_REGISTRY, [KEYS.asset]: ASSET_REGISTRY, ...configLine }), {
      calls: { 'njangi_compliance::create_config': callOutput(NEW_CONFIG, types(UPGRADED).config) },
      env: { NJANGI_BOOTSTRAP_UPGRADE_CAP_ID: UPGRADE_CAP },
    });

    expect(run.code).toBe(0);
    expect(signed(run)).toEqual([
      [
        'client',
        'call',
        '--package',
        UPGRADED,
        '--module',
        'njangi_compliance',
        '--function',
        'create_config',
        '--args',
        UPGRADE_CAP,
        '--gas-budget',
        '200000000',
        '--json',
      ],
    ]);
    const after = dotenv.parse(run.env);
    expect(after[KEYS.config]).toBe(NEW_CONFIG);
    expect(after[KEYS.wa]).toBe(WA_REGISTRY);
    expect(after[KEYS.asset]).toBe(ASSET_REGISTRY);
  });

  it("takes the UpgradeCap from move/Published.toml's table for the network", async () => {
    const capId = publishedValue(readFileSync(path.join(repoRoot, 'move/Published.toml'), 'utf8'), 'testnet', 'upgrade-capability');
    expect(capId).toBeDefined();
    chain = {
      ...upgradeWithoutConfig,
      objects: {
        ...upgradeWithoutConfig.objects,
        [normalizeSuiId(capId as string)]: { data: { ...upgradeCap(DEPLOYER, UPGRADED).data, objectId: capId } },
      },
    };

    const run = await bootstrap(UPGRADED, envFile({ [KEYS.wa]: WA_REGISTRY, [KEYS.asset]: ASSET_REGISTRY }), {
      calls: { 'njangi_compliance::create_config': callOutput(NEW_CONFIG, types(UPGRADED).config) },
    });

    expect(run.code).toBe(0);
    expect(signed(run).map((args) => args[args.indexOf('--args') + 1])).toEqual([capId]);
  });

  it.each([
    [
      'the configured config cannot be read',
      { ...testnet, fail: { [`sui_getObject:${TESTNET_CONFIG}`]: { status: 429 } } },
      V9,
      TESTNET_CONFIG,
      `reading ${TESTNET_CONFIG} failed: rpc sui_getObject http 429`,
    ],
    // Testnet with the variable unset: publicnode no longer serves the publish.
    [
      'the publish that introduced the config type is pruned',
      testnet,
      V9,
      '',
      'Could not find the referenced transaction [TransactionDigest(4QJj9JMDMBs5mUtvQwMXpFEbh3AigXJ5ZxAeXTRb25jt)]',
    ],
    [
      'the event query fails',
      {
        ...upgradeWithoutConfig,
        fail: {
          suix_queryEvents: {
            error: { code: -32603, message: 'Could not find the referenced transaction events [TransactionDigest(UpgradeTx)].' },
          },
        },
      },
      UPGRADED,
      '',
      `querying ${types(UPGRADED).createdEvent} events failed`,
    ],
  ])('signs nothing and leaves the env file byte-identical when %s', async (_label, failingChain, pkg, configured, cause) => {
    chain = failingChain;
    // Placeholder registries prove that nothing at all is signed, not just create_config.
    const before = `# local\n${KEYS.wa}=0xyour_testnet_whatsapp_registry_id\n${KEYS.asset}=\n${KEYS.config}=${configured}\n`;

    const run = await bootstrap(pkg, before, {
      calls: {
        'whatsapp_integration::init_registry': callOutput(`0x${'e1'.repeat(32)}`, types(UPGRADED).wa),
        'njangi_price_validator::init_registry': callOutput(`0x${'e2'.repeat(32)}`, types(UPGRADED).asset),
      },
      env: { NJANGI_BOOTSTRAP_UPGRADE_CAP_ID: UPGRADE_CAP },
    });

    expect(run.code).toBe(1);
    expect(signed(run)).toEqual([]);
    expect(run.env).toBe(before);
    expect(run.stdout).toContain(`${KEYS.config}: `);
    expect(run.stdout).toContain(cause);
    expect(run.stderr).toContain('stopped before signing anything');
  });

  it('signs nothing when the active address does not hold the UpgradeCap', async () => {
    chain = {
      ...upgradeWithoutConfig,
      objects: { ...upgradeWithoutConfig.objects, [UPGRADE_CAP]: upgradeCap(OTHER, UPGRADED) },
    };
    const before = envFile({ [KEYS.wa]: '', [KEYS.asset]: '' });

    const run = await bootstrap(UPGRADED, before, { env: { NJANGI_BOOTSTRAP_UPGRADE_CAP_ID: UPGRADE_CAP } });

    expect(run.code).toBe(1);
    expect(signed(run)).toEqual([]);
    expect(run.env).toBe(before);
    expect(run.stdout).toContain(`not by the active address ${DEPLOYER}`);
  });

  it('reports an aborted create_config and keeps the env variable as it was', async () => {
    chain = upgradeWithoutConfig;
    const before = envFile({ [KEYS.wa]: WA_REGISTRY, [KEYS.asset]: ASSET_REGISTRY, [KEYS.config]: '' });
    const abort =
      'MoveAbort(MoveLocation { module: ModuleId { address: b2b2, name: Identifier("njangi_compliance") }, ' +
      'function: 1, instruction: 9, function_name: Some("assert_canonical_upgrade_cap") }, 306) in command 0';

    const run = await bootstrap(UPGRADED, before, {
      calls: {
        'njangi_compliance::create_config': { effects: { status: { status: 'failure', error: abort }, created: [] } },
      },
      env: { NJANGI_BOOTSTRAP_UPGRADE_CAP_ID: UPGRADE_CAP },
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('njangi_compliance::create_config failed on chain');
    expect(run.stderr).toContain('306)');
    expect(dotenv.parse(run.env)[KEYS.config]).toBe('');
  });
});
