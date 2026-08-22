/**
 * Drawing a random payout order for the rotation editor.
 *
 * Kept out of the component so the one property that matters can be tested:
 * a shuffle that returns the order it started from is indistinguishable from
 * a button that did nothing. That exact confusion is why the old
 * commit-on-click shuffle was mistaken for broken — it left the list
 * untouched — and a plain Fisher-Yates reproduces it in miniature, since the
 * identity permutation is a perfectly ordinary draw (1 in 2 for two members,
 * 1 in 6 for three).
 */

/**
 * Returns `items` in a random order, re-rolling while the draw matches the
 * input.
 *
 * Bounded rather than looping until success: for a list of two the identity
 * comes up half the time, and returning an unchanged list is far better than
 * spinning. With the default budget the odds of giving up on a 2-element list
 * are 1 in 256.
 *
 * `random` is injectable so the re-roll can be tested rather than assumed.
 */
export function shuffleDistinct<T>(
  items: readonly T[],
  identity: (item: T) => string,
  options: { maxAttempts?: number; random?: () => number } = {},
): T[] {
  const { maxAttempts = 8, random = Math.random } = options;

  // Nothing to rearrange, and no draw can differ from the input.
  if (items.length < 2) return [...items];

  const original = items.map(identity);
  const unchanged = (candidate: readonly T[]) =>
    candidate.every((item, index) => identity(item) === original[index]);

  const draw = (): T[] => {
    const next = [...items];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
    return next;
  };

  let candidate = draw();
  for (let attempt = 1; attempt < maxAttempts && unchanged(candidate); attempt++) {
    candidate = draw();
  }
  return candidate;
}
