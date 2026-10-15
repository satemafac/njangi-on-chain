import { readFileSync } from 'fs';
import { join } from 'path';
import { DICTIONARIES } from '@/lib/i18n';
import {
  signInFailureKey,
  startSignIn,
  type SignInFailureKey,
  type SignInStartState,
} from '../sign-in-start';
import { SuiNetworkUnavailableError } from '../sui-epoch';

function withCode(code: string): Error {
  return Object.assign(new Error(`Failed to begin login: ${code}`), { code });
}

describe('signInFailureKey', () => {
  it('explains a Sui network outage (the 2026-10-15 failure)', () => {
    expect(signInFailureKey(withCode('SUI_NETWORK_UNAVAILABLE'))).toBe('auth.startFailed.suiNetwork');
    expect(signInFailureKey(new SuiNetworkUnavailableError('testnet'))).toBe('auth.startFailed.suiNetwork');
  });

  it('asks for a refresh when the server rejected the browser key', () => {
    expect(signInFailureKey(withCode('EPHEMERAL_KEY_REQUIRED'))).toBe('auth.startFailed.refresh');
  });

  it.each(['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed'])(
    'reads a fetch that never reached a server (%s) as a connection problem',
    (message) => {
      expect(signInFailureKey(new TypeError(message))).toBe('auth.startFailed.offline');
    },
  );

  it('does not blame the connection for a TypeError from a bug', () => {
    expect(
      signInFailureKey(new TypeError("Cannot read properties of undefined (reading 'loginUrl')")),
    ).toBe('auth.startFailed.generic');
  });

  it('falls back to the generic message for anything else', () => {
    expect(signInFailureKey(withCode('HTTP_500'))).toBe('auth.startFailed.generic');
    expect(signInFailureKey(new Error('No login URL returned'))).toBe('auth.startFailed.generic');
    expect(signInFailureKey('boom')).toBe('auth.startFailed.generic');
    expect(signInFailureKey(null)).toBe('auth.startFailed.generic');
  });

  it.each<SignInFailureKey>([
    'auth.startFailed.suiNetwork',
    'auth.startFailed.offline',
    'auth.startFailed.refresh',
    'auth.startFailed.generic',
  ])('%s has English and French copy', (key) => {
    expect(DICTIONARIES.en[key]).toBeTruthy();
    expect(DICTIONARIES.fr[key]).toBeTruthy();
  });
});

describe('startSignIn', () => {
  it('marks the provider as opening, then shows why it failed', async () => {
    const states: SignInStartState[] = [];
    const login = jest.fn().mockRejectedValue(withCode('SUI_NETWORK_UNAVAILABLE'));

    await expect(startSignIn('Google', login, (s) => states.push(s))).resolves.toBeUndefined();

    expect(login).toHaveBeenCalledWith('Google');
    expect(states).toEqual([
      { pending: 'Google', failure: null },
      { pending: null, failure: 'auth.startFailed.suiNetwork' },
    ]);
  });

  it('stays busy after a successful start, because the page is leaving', async () => {
    const states: SignInStartState[] = [];
    await startSignIn('Apple', jest.fn().mockResolvedValue(undefined), (s) => states.push(s));

    expect(states).toEqual([{ pending: 'Apple', failure: null }]);
  });

  it('clears an earlier failure when the user tries again', async () => {
    const states: SignInStartState[] = [];
    await startSignIn('Facebook', jest.fn().mockResolvedValue(undefined), (s) => states.push(s));

    expect(states[0]).toEqual({ pending: 'Facebook', failure: null });
  });
});

// The route is too heavy to import here (Cetus SDKs and friends), so its
// mapping is read from source, as capability-gate-partitioning.test.ts does.
describe('/api/zkLogin maps a Sui outage to a coded 503', () => {
  const route = readFileSync(join(process.cwd(), 'src/pages/api/zkLogin.ts'), 'utf8');

  it('answers 503 with the error code instead of an opaque 500', () => {
    const mapping = route.slice(route.indexOf('err instanceof SuiNetworkUnavailableError'));
    expect(mapping).toMatch(
      /^err instanceof SuiNetworkUnavailableError\) \{[\s\S]{0,200}res\.status\(503\)\.json\(\{ error: err\.message, code: err\.code \}\)/,
    );
  });

  it('carries the code the sign-in button keys on', () => {
    expect(new SuiNetworkUnavailableError('testnet').code).toBe('SUI_NETWORK_UNAVAILABLE');
  });
});
