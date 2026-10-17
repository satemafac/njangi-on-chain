// CashOutGuide with balances that could not be read: no "(0)" figure, Max is
// disabled, and the reason is shown instead of "exceeds your balance".

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CashOutGuide } from '../CashOutGuide';

const render = (props: { balancesUnavailable?: boolean; availableUsdc?: number; availableSui?: number }) =>
  renderToStaticMarkup(
    createElement(CashOutGuide, {
      isOpen: true,
      onClose: () => {},
      onSend: async () => {},
      availableUsdc: props.availableUsdc ?? 0,
      availableSui: props.availableSui ?? 0,
      balancesUnavailable: props.balancesUnavailable,
    }),
  );

it('shows real balances when they were read', () => {
  const html = render({ availableUsdc: 12.5, availableSui: 4.33 });
  expect(html).toContain('(12.5)');
  expect(html).toContain('(4.33)');
  expect(html).not.toContain("couldn&#x27;t load your balance");
});

it('shows no figure, disables Max, and says why when balances are unavailable', () => {
  const html = render({ balancesUnavailable: true });
  expect(html).not.toContain('(0)');
  expect(html.match(/\(—\)/g)?.length).toBe(2);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Max<\/button>/);
  expect(html).toContain('We couldn&#x27;t load your balance, so this amount can&#x27;t be checked.');
});
