/**
 * The text a member copies after collecting. Its round is the circle-wide
 * round number; the escrow's cycle_no counts laps, so the 16th payout of
 * the 3-member production circle used to be shared as "round 6".
 */
import { buildShareText } from '../payout-share-text';

describe('buildShareText', () => {
  it('names the circle-wide round', () => {
    expect(buildShareText({ amount: '0.2 USDC', roundNo: 16, circleName: 'Bamenda Savers' })).toBe(
      "It's my turn: I just received my circle payout of 0.2 USDC in Bamenda Savers, round 16. " +
        'Nobody held the pot. njangionchain.com',
    );
  });

  it('leaves an unknown round out instead of sharing a placeholder', () => {
    const text = buildShareText({ amount: '0.2 USDC', roundNo: '—', circleName: 'Bamenda Savers' });
    expect(text).toContain('in Bamenda Savers. Nobody held the pot.');
    expect(text).not.toMatch(/round|—/);
  });
});
