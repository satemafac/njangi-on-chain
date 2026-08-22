import { shuffleDistinct } from '@/lib/rotation-shuffle';

const id = (s: string) => s;
const MEMBERS = ['a', 'b', 'c', 'd'];

describe('shuffleDistinct', () => {
  it('keeps every member exactly once', () => {
    const out = shuffleDistinct(MEMBERS, id);

    expect([...out].sort()).toEqual([...MEMBERS].sort());
    expect(out).toHaveLength(MEMBERS.length);
  });

  it('does not mutate the input', () => {
    const input = [...MEMBERS];
    shuffleDistinct(input, id);

    expect(input).toEqual(MEMBERS);
  });

  // The property the component depends on: a draw that comes back in the
  // original order is re-rolled, because a shuffle that visibly does nothing
  // reads as a broken button.
  it('re-rolls a draw that matches the current order', () => {
    // First draw is the identity permutation, second swaps.
    const draws = [
      () => 0.99, // i=1, j=1 -> no swap
      () => 0.0, // i=1, j=0 -> swap
    ];
    let call = 0;
    const random = () => draws[Math.min(call++, draws.length - 1)]();

    const out = shuffleDistinct(['a', 'b'], id, { random });

    expect(out).toEqual(['b', 'a']);
    expect(call).toBeGreaterThan(1); // it drew more than once
  });

  // Better an unchanged list than a hang.
  it('gives up after the attempt budget rather than looping forever', () => {
    let call = 0;
    const random = () => {
      call++;
      return 0.99; // always the identity permutation
    };

    const out = shuffleDistinct(['a', 'b'], id, { maxAttempts: 3, random });

    expect(out).toEqual(['a', 'b']);
    expect(call).toBe(3);
  });

  it('returns short lists untouched without drawing', () => {
    const random = jest.fn();

    expect(shuffleDistinct([], id, { random })).toEqual([]);
    expect(shuffleDistinct(['solo'], id, { random })).toEqual(['solo']);
    expect(random).not.toHaveBeenCalled();
  });

  it('compares by identity, so equal-looking objects still count as moved', () => {
    const people = [{ addr: '0xa' }, { addr: '0xb' }];
    const out = shuffleDistinct(people, (p) => p.addr);

    expect(out.map((p) => p.addr).sort()).toEqual(['0xa', '0xb']);
  });
});
