import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AUTH_CALLBACK_FRAGMENT_KEY,
  AUTH_CALLBACK_FRAGMENT_SCRIPT,
  clearAuthCallbackFragment,
  readAuthCallbackFragment,
} from '@/lib/auth-callback-fragment';

const GOOGLE_FRAGMENT =
  '#iss=https://accounts.google.com&id_token=eyJhbGciOiJSUzI1NiJ9.e30.sig&authuser=1&prompt=none';

type FakeWindow = {
  location: { pathname: string; search: string; hash: string };
  history: { state: unknown; replaceState: jest.Mock };
  [key: string]: unknown;
};

function fakeWindow(pathname: string, hash: string, search = ''): FakeWindow {
  return {
    location: { pathname, search, hash },
    history: { state: { idx: 3 }, replaceState: jest.fn() },
  };
}

/** Runs the _document inline script against a fake `window`. */
function runInlineScript(win: FakeWindow) {
  // The script is ES5 and only touches `window`, so it can be evaluated
  // with the fake bound to that identifier.
  new Function('window', AUTH_CALLBACK_FRAGMENT_SCRIPT)(win);
}

describe('AUTH_CALLBACK_FRAGMENT_SCRIPT (pre-hydration inline script)', () => {
  it('stashes the fragment and strips it from the callback URL before Next boots', () => {
    const win = fakeWindow('/auth/callback', GOOGLE_FRAGMENT);

    runInlineScript(win);

    expect(win[AUTH_CALLBACK_FRAGMENT_KEY]).toBe(GOOGLE_FRAGMENT);
    expect(win.history.replaceState).toHaveBeenCalledTimes(1);
    expect(win.history.replaceState).toHaveBeenCalledWith({ idx: 3 }, '', '/auth/callback');
  });

  it('keeps the query string when stripping the fragment', () => {
    const win = fakeWindow('/auth/callback', '#id_token=abc', '?state=xyz');

    runInlineScript(win);

    expect(win.history.replaceState).toHaveBeenCalledWith(expect.anything(), '', '/auth/callback?state=xyz');
  });

  it('leaves every other page and an empty hash untouched', () => {
    const marketing = fakeWindow('/learn', '#faq');
    const noHash = fakeWindow('/auth/callback', '');

    runInlineScript(marketing);
    runInlineScript(noHash);

    expect(marketing[AUTH_CALLBACK_FRAGMENT_KEY]).toBeUndefined();
    expect(marketing.history.replaceState).not.toHaveBeenCalled();
    expect(noHash[AUTH_CALLBACK_FRAGMENT_KEY]).toBeUndefined();
    expect(noHash.history.replaceState).not.toHaveBeenCalled();
  });

  it('never throws, even when history is unavailable', () => {
    const win = fakeWindow('/auth/callback', '#id_token=abc');
    win.history.replaceState = jest.fn(() => {
      throw new Error('SecurityError');
    });

    expect(() => runInlineScript(win)).not.toThrow();
  });
});

describe('readAuthCallbackFragment', () => {
  it('prefers the stash the inline script left, without the leading #', () => {
    const win = fakeWindow('/auth/callback', '');
    runInlineScript(Object.assign(win, { location: { ...win.location, hash: GOOGLE_FRAGMENT } }));
    // After the script the live hash is gone — simulate the browser.
    win.location.hash = '';

    const fragment = readAuthCallbackFragment(win as unknown as Window);

    expect(fragment).toBe(GOOGLE_FRAGMENT.slice(1));
    expect(new URLSearchParams(fragment).get('id_token')).toBe('eyJhbGciOiJSUzI1NiJ9.e30.sig');
  });

  it('falls back to the live hash when the inline script did not run', () => {
    const win = fakeWindow('/auth/callback', '#id_token=live');

    expect(readAuthCallbackFragment(win as unknown as Window)).toBe('id_token=live');
  });

  it('is repeatable: a StrictMode re-run of the callback effect sees the same token', () => {
    const win = fakeWindow('/auth/callback', GOOGLE_FRAGMENT);
    runInlineScript(win);
    win.location.hash = '';

    const first = readAuthCallbackFragment(win as unknown as Window);
    const second = readAuthCallbackFragment(win as unknown as Window);

    expect(second).toBe(first);
    expect(second).toContain('id_token=');
  });
});

describe('clearAuthCallbackFragment', () => {
  it('removes the stash so the JWT does not outlive the page on window', () => {
    const win = fakeWindow('/auth/callback', GOOGLE_FRAGMENT);
    runInlineScript(win);
    win.location.hash = '';

    clearAuthCallbackFragment(win as unknown as Window);

    expect(win[AUTH_CALLBACK_FRAGMENT_KEY]).toBeUndefined();
    expect(readAuthCallbackFragment(win as unknown as Window)).toBe('');
  });
});

/**
 * The arguments of every console.* call in `source`, with comments dropped
 * and plain '…' / "…" string literals blanked, so message text ("ID token
 * not found in URL hash") does not count. Template literals stay whole:
 * `${window.location.href}` must still be caught.
 */
function consoleCallArguments(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const calls: string[] = [];
  const start = /console\.(?:log|info|warn|error|debug|trace)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(code))) {
    let i = match.index + match[0].length;
    let depth = 1;
    let args = '';
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === '"' || c === "'" || c === '`') {
        const begin = i;
        i += 1;
        while (i < code.length && code[i] !== c) i += code[i] === '\\' ? 2 : 1;
        i += 1;
        args += c === '`' ? code.slice(begin, i) : '""';
        continue;
      }
      if (c === '(') depth += 1;
      if (c === ')') depth -= 1;
      if (depth > 0) args += c;
      i += 1;
    }
    calls.push(args);
  }
  return calls;
}

describe('the callback page never logs the URL, the fragment or the token', () => {
  // It used to log window.location.href and .hash on every sign-in, which
  // put the id_token (a JWT carrying the user's email and sub) in the
  // browser console and in console breadcrumbs.
  const source = readFileSync(join(process.cwd(), 'src/pages/auth/callback.tsx'), 'utf8');
  const calls = consoleCallArguments(source);
  const FORBIDDEN =
    /\b(?:location|href|hash|hashParams|search|searchParams|idToken|id_token|fullUrl|tokenMatch|userDataParam|appleUserData)\b/;

  it('finds the page console calls (guards against a vacuous scan)', () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it('passes none of them a URL part or the token', () => {
    expect(calls.filter((args) => FORBIDDEN.test(args))).toEqual([]);
  });

  it('catches the shapes that leaked before', () => {
    const leaky = [
      "console.log('URL information:', { fullUrl: window.location.href, hash: window.location.hash });",
      'console.log(`landed on ${window.location.href}`);',
      "console.log('token', idToken);",
    ].join('\n');

    expect(consoleCallArguments(leaky).filter((args) => FORBIDDEN.test(args))).toHaveLength(3);
  });
});
