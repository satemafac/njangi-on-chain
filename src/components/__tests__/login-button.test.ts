// LoginButtonView rendered in each state. The suite runs under node with no
// DOM, so the view is stateless by design and rendered to static markup; the
// state transitions are covered in src/lib/__tests__/sign-in-start.test.ts.

jest.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ login: jest.fn() }),
}));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DICTIONARIES, t } from '@/lib/i18n';
import { LoginButtonView } from '../LoginButton';
import { IDLE_SIGN_IN_STATE, type SignInStartState } from '@/lib/sign-in-start';

function render(state: SignInStartState, variant: 'default' | 'landing'): string {
  return renderToStaticMarkup(
    createElement(LoginButtonView, { variant, state, onSelect: () => {}, t }),
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe.each(['landing', 'default'] as const)('LoginButtonView (%s)', (variant) => {
  it('shows three enabled providers and no alert when idle', () => {
    const html = render(IDLE_SIGN_IN_STATE, variant);

    expect(html).not.toContain('role="alert"');
    expect(count(html, 'disabled=""')).toBe(0);
    expect(html).toContain('Continue with Google');
  });

  // The 2026-10-15 symptom: the server failed and the modal said nothing.
  it('says why sign-in did not start, and lets the user try again', () => {
    const html = render({ pending: null, failure: 'auth.startFailed.suiNetwork' }, variant);

    expect(html).toContain('role="alert"');
    expect(html).toContain(
      DICTIONARIES.en['auth.startFailed.suiNetwork'].replaceAll("'", '&#x27;'),
    );
    expect(count(html, 'disabled=""')).toBe(0);
  });

  it('marks the chosen provider busy and locks every button while it opens', () => {
    const html = render({ pending: 'Google', failure: null }, variant);

    expect(html).toContain('Opening Google…');
    expect(count(html, 'aria-busy="true"')).toBe(1);
    expect(count(html, 'disabled=""')).toBe(3);
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('Continue with Facebook');
  });
});
