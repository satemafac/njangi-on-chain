# Constraints for the ambassador / referral spec (read before writing SPEC.md)

These come from the repo's CLAUDE.md. They are legal invariants of the
"non-custodial coordination software" posture, not preferences. A spec that
breaks one is a regulatory event, and Claude will not implement it.

1. **No fees on fund flows, ever.** Revenue is the coordination subscription
   ($9.99/mo Premium) only. Never a cut, spread or fee on contributions,
   payouts or swaps. Therefore "fee-free first round" cannot be a lever:
   rounds are never charged. The equivalent lever is a free month (or months)
   of Premium for the organiser, or a free Premium slot for the ambassador.
2. **Referral revenue share, if any, comes only out of subscription revenue**,
   is paid off-platform by the founder's decision, and its mechanics need
   counsel review before design. The spec may describe it as a DECISION for
   the founder, not as a built feature.
3. **No custody.** No operator or admin function may direct user funds. So no
   ambassador payout that the platform holds or moves; nothing that touches a
   circle's pot.
4. **No scoring members.** The Circle Record is a member-owned proof of
   participation, never a rating, tier or score. Ambassador status must not
   become a score on anyone, and must not be shown to other members as one.
5. **No yield or investment features**, and none of this vocabulary anywhere
   in copy or UI: interest, returns, yield, earn, invest, guaranteed, savings
   account, deposit (for the pot), audited, blockchain, crypto, wallet.
6. **Attribution must be privacy-preserving.** Referral codes/links attribute a
   signup to an ambassador without exposing who invited whom to other members.
   PII stays off the public ledger (the product already encrypts routing data;
   see `src/lib/walrus-pii.ts`).

Format Claude needs: write `SPEC.md` in this folder. Mark every choice the
founder must make with a line starting `DECISION:`. Keep mechanics that need
code separate from mechanics that are content or ops. Claude implements what
the founder approves.
