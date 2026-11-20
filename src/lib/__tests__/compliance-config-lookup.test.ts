// resolveComplianceConfigId / requireComplianceConfigId: "no config" and
// "couldn't read the chain" are different answers. Before, every read
// failure became null and the member was told verification "is not
// configured yet, contact support", during an RPC outage.

jest.mock('../../services/network-config', () => ({
  getNetworkConfig: () => ({ rpcUrl: 'https://rpc.invalid' }),
  getPackageIdForNetwork: () => '0xcurrent',
}));
jest.mock('../../services/sui-rpc-failover', () => ({
  getPooledSuiClient: () => {
    throw new Error('tests pass their own client');
  },
}));
jest.mock('../circle-chain', () => ({
  getPublishedPackageMetadata: () => ({ originalId: '0xoriginal', publishedAt: '0xcurrent' }),
  getPackageLookupIds: () => ['0xcurrent', '0xoriginal'],
}));

type Gate = typeof import('../compliance-gate');
const PIN_ENV = 'NEXT_PUBLIC_TESTNET_NJANGI_COMPLIANCE_CONFIG_ID';

// The resolver caches a found id per network for the page lifetime, so each
// test loads a fresh copy of the module.
function loadGate(): Gate {
  let gate!: Gate;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    gate = require('../compliance-gate');
  });
  return gate;
}

const created = (configId: string) => ({ data: [{ parsedJson: { config_id: configId } }] });
const none = { data: [] };
const down = () => Promise.reject(new Error('Unexpected status code: 503'));

function client(opts: {
  getObject?: () => Promise<unknown>;
  queryEvents: Array<() => Promise<unknown>>;
}) {
  const queryEvents = jest.fn();
  for (const answer of opts.queryEvents) queryEvents.mockImplementationOnce(answer);
  return {
    getObject: jest.fn(opts.getObject ?? (() => Promise.resolve({}))),
    queryEvents,
  } as never;
}

beforeEach(() => {
  delete process.env[PIN_ENV];
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('resolveComplianceConfigId', () => {
  it('returns the config announced on any lineage id, even if another lineage read failed', async () => {
    const { resolveComplianceConfigId } = loadGate();
    const c = client({ queryEvents: [down, () => Promise.resolve(created('0xconfig'))] });
    await expect(resolveComplianceConfigId('testnet', c)).resolves.toBe('0xconfig');
  });

  it('returns null only when every lineage answered with no config', async () => {
    const { resolveComplianceConfigId } = loadGate();
    const c = client({ queryEvents: [() => Promise.resolve(none), () => Promise.resolve(none)] });
    await expect(resolveComplianceConfigId('testnet', c)).resolves.toBeNull();
  });

  it('throws ComplianceConfigUnavailableError when a read failed and nothing was found', async () => {
    const { resolveComplianceConfigId, ComplianceConfigUnavailableError } = loadGate();
    const c = client({ queryEvents: [down, () => Promise.resolve(none)] });
    await expect(resolveComplianceConfigId('testnet', c)).rejects.toBeInstanceOf(
      ComplianceConfigUnavailableError,
    );
  });

  it('uses a pinned id once it verifies on chain, without replaying events', async () => {
    process.env[PIN_ENV] = '0xpinned';
    const { resolveComplianceConfigId } = loadGate();
    const c = client({
      getObject: () =>
        Promise.resolve({ data: { type: '0xoriginal::njangi_compliance::ComplianceConfig' } }),
      queryEvents: [],
    });
    await expect(resolveComplianceConfigId('testnet', c)).resolves.toBe('0xpinned');
  });

  it('treats an unreadable pin plus an empty replay as unknown, not "no config"', async () => {
    process.env[PIN_ENV] = '0xpinned';
    const { resolveComplianceConfigId, ComplianceConfigUnavailableError } = loadGate();
    const c = client({
      getObject: down,
      queryEvents: [() => Promise.resolve(none), () => Promise.resolve(none)],
    });
    await expect(resolveComplianceConfigId('testnet', c)).rejects.toBeInstanceOf(
      ComplianceConfigUnavailableError,
    );
  });
});

describe('requireComplianceConfigId', () => {
  it('hands back the id when there is one', async () => {
    const { requireComplianceConfigId } = loadGate();
    const c = client({ queryEvents: [() => Promise.resolve(created('0xconfig'))] });
    await expect(requireComplianceConfigId('testnet', { client: c })).resolves.toEqual({ id: '0xconfig' });
  });

  it('says verification is not configured only when that is known', async () => {
    const { requireComplianceConfigId, COMPLIANCE_CONFIG_MISSING_MESSAGE } = loadGate();
    const c = client({ queryEvents: [() => Promise.resolve(none), () => Promise.resolve(none)] });
    await expect(requireComplianceConfigId('testnet', { client: c })).resolves.toEqual({
      error: COMPLIANCE_CONFIG_MISSING_MESSAGE,
    });
  });

  it('uses a caller-specific message for a known-missing config', async () => {
    const { requireComplianceConfigId } = loadGate();
    const c = client({ queryEvents: [() => Promise.resolve(none), () => Promise.resolve(none)] });
    await expect(
      requireComplianceConfigId('testnet', { client: c, missingMessage: 'Not for this pool.' }),
    ).resolves.toEqual({ error: 'Not for this pool.' });
  });

  it('says the network could not be reached when the reads failed', async () => {
    const { requireComplianceConfigId, COMPLIANCE_CONFIG_UNREADABLE_MESSAGE } = loadGate();
    const c = client({ queryEvents: [down, down] });
    const result = await requireComplianceConfigId('testnet', { client: c });
    expect(result).toEqual({ error: COMPLIANCE_CONFIG_UNREADABLE_MESSAGE });
    expect(COMPLIANCE_CONFIG_UNREADABLE_MESSAGE).not.toMatch(/not configured|contact support/i);
  });
});

// Every gated caller goes through the helper; none swallows into null again.
describe('gated callers', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('fs') as typeof import('fs');
  it.each([
    'src/components/CycleEscrowPanel.tsx',
    'src/components/goals/GoalPoolPanel.tsx',
    'src/pages/create-circle.tsx',
  ])('%s uses requireComplianceConfigId, not a swallowed resolveComplianceConfigId', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('requireComplianceConfigId(network');
    expect(source).not.toMatch(/resolveComplianceConfigId\([^)]*\)\.catch\(/);
  });
});
