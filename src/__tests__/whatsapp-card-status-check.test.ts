/**
 * Source guards for the manage page's WhatsApp card when it can't read the
 * circle's link status.
 *
 * checkLinkStatus used to answer every failed read of
 * GET /api/whatsapp/admin-link-circle with `isLinked: false`: a 500 from an
 * RPC or registry error, a network error, a body that isn't JSON. The card
 * then looked exactly like a circle with no link and offered "Link to
 * WhatsApp" for a circle that may already be linked on chain. A failed read
 * now sets `loadError`: the card says it couldn't check and offers Retry,
 * and nothing that links or unlinks.
 *
 * Source-text assertions rather than render tests, as in
 * src/lib/__tests__/copy-guards.test.ts: jest runs `testEnvironment: 'node'`
 * and matches only `.test.ts`, so nothing can render a `.tsx` here.
 */
import { readFileSync } from 'fs';
import path from 'path';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

/** Comments explain the rule; they must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The `{ … }` block that opens at the first `{` after `marker`. */
const blockAfter = (source: string, marker: string): string => {
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`not found: ${marker}`);
  const open = source.indexOf('{', at + marker.length);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced: ${marker}`);
};

const count = (source: string, re: RegExp): number => (source.match(re) ?? []).length;

const card = stripComments(read('components/WhatsAppCircleIntegration.tsx'));
// Looked up inside each test, so a missing block fails that test by name.
const check = () => blockAfter(card, 'const checkLinkStatus = async () =>');
const failedView = () => blockAfter(card, 'if (loadError)');

describe('WhatsApp card: a failed link-status read', () => {
  it('is not turned into "not linked"', () => {
    const onFailure = blockAfter(check(), 'catch (');

    expect(onFailure).toContain('setLoadError(true)');
    expect(onFailure).not.toContain('setLinkedStatus');
    expect(onFailure).not.toMatch(/isLinked:\s*false/);
  });

  it('includes a non-OK reply and a reply without an isLinked flag', () => {
    // Both used to fall through to `isLinked: false`. If this read moves into
    // a lib helper, point these at the card's call to it and pin the throws
    // in the helper's unit tests.
    expect(check()).toMatch(/if \(!response\.ok\) \{\s*throw new Error\(/);
    expect(check()).toMatch(
      /if \(typeof data\?\.data\?\.isLinked !== 'boolean'\) \{\s*throw new Error\(/,
    );
  });

  it('is cleared by the next check and by nothing else', () => {
    expect(check()).toContain('setLoadError(false)');
    expect(count(card, /setLoadError\(/g)).toBe(count(check(), /setLoadError\(/g));
  });

  it('says the status could not be checked and offers Retry', () => {
    const view = failedView();

    expect(view).toContain(`{"Couldn't check WhatsApp status"}`);
    expect(view).toContain('This circle may already be linked');
    expect(view).toContain('onClick={() => checkLinkStatus()}');
    expect(view).toMatch(/\bRetry\b/);
  });

  it('offers no link form, Link button or Unlink while the status is unknown', () => {
    const view = failedView();

    expect(view).toContain('return (');
    for (const control of [
      'Link to WhatsApp',
      '<form',
      'setShowLinkForm',
      'handleLinkCircle',
      'setShowUnlinkConfirm',
      'linkedStatus',
    ]) {
      expect(view).not.toContain(control);
    }

    // It returns before the view that holds those controls.
    const failedViewAt = card.indexOf('if (loadError)');
    expect(failedViewAt).toBeLessThan(card.indexOf('Link to WhatsApp'));
    expect(failedViewAt).toBeLessThan(card.indexOf('<form'));
    expect(failedViewAt).toBeLessThan(card.indexOf('Unlink from WhatsApp'));
  });
});

describe('WhatsApp card: before the first read answers', () => {
  it('shows the spinner, not the not-linked view', () => {
    // linkedStatus starts as { isLinked: false }; loading must cover it.
    expect(card).toMatch(/const \[loading, setLoading\] = useState\(true\);/);
  });
});
