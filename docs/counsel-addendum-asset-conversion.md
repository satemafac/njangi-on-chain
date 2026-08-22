# Counsel addendum — member-directed asset conversion ("Asset Njangi")

**Date:** 2026-08-20
**Send:** with, or immediately after, `docs/counsel-brief.md`. That brief asks whether our
launch posture holds. This addendum asks whether **one specific new feature** can be built
without breaking it.
**Status:** No design work has started and none will start before we have written answers to
Section 3. This is deliberate — see `docs/compliance-roadmap-cex-dex-non-kyc.md` Phase C.

> We are not asking counsel to bless a built feature. We are asking, before we draw a single
> screen, which of three delivery variants (if any) we may build.

---

## 1. Why we want this

Our product coordinates rotating savings groups (njangi / tontine / ROSCA). Members contribute
on a schedule; each cycle one member receives the whole pot. The pot is held in per-cycle escrow
on-chain and only the scheduled recipient can release it to themselves. We never hold or direct
member funds, never touch fiat, and take no fee from any fund flow. Revenue is a subscription
billed to the group's organizer for coordination features (reminders, records), never a cut of
money movement.

The commercial problem: **the payout evaporates.** A member receives a lump sum and it is spent
within days, because most of our users — in Cameroon and in the diaspora — have never had
realistic access to a brokerage or a long-term savings instrument. Our members have asked for a
way to keep some of it.

The opportunity that made this concrete: as of 4 August 2026 there is, for the first time, a
regulated route for **US persons** to hold tokenized US equities from a self-custody wallet
(Dinari — SEC-registered transfer agent, FINRA/SIPC broker-dealer affiliate, settled in USDC).
Non-US members have separate Reg S products available. So the feature is now buildable in
principle. Whether it is buildable *by us* is the question.

## 2. What we would (and would not) do

**The shape we intend.** After a member has claimed their payout — the funds are already theirs,
already in their own self-custodied account, and the circle's involvement is finished — the app
would show an **optional** screen. It would say, in substance: *you can keep this as dollars, send
it out, or open an account with one of these licensed providers.* Selecting a provider hands the
member off to that provider's own onboarding and flow.

**What we would not do, in any variant.**

- No fee, spread, rebate, or per-conversion compensation of any kind. We have concluded
  independently that per-conversion economics would breach our own no-fee-on-fund-flows invariant
  *and* look like transaction-based compensation; we raise it here so you can tell us whether even
  a **flat, volume-independent marketing fee** is safe, or whether we should take nothing at all.
- No recommendation, ranking by payment, suitability judgement, or advice about what a member
  should do with their money. Ordering would be by member geography and eligibility only.
- No custody. At no point can we move, hold, or redirect the member's funds or assets.
- No participation in the group's decision. This is one member's private choice about their own
  money after the group's business has concluded.

## 3. The questions we need answered

1. **Is variant (a) permissible, and on what conditions?**
   *Variant (a) — guided handoff.* We show an optional informational screen listing eligible
   licensed providers for the member's country and link out. No funds routed by us, no API
   integration, no order transmitted, no fee.
   Does presenting that screen make us a broker-dealer, an unregistered finder, or an investment
   adviser? What must the screen say — and not say — to stay clearly on the right side? Is there a
   difference between listing one provider and listing several?

2. **Does any compensation survive?** If we accept a flat annual marketing fee unrelated to volume
   or conversions, does that change the answer to Q1? Our working assumption is that we should
   take **nothing**, and we would rather be told that plainly than discover it later.

3. **Is variant (b) permissible?**
   *Variant (b) — on-chain conversion for non-US members.* The member signs a single transaction
   that exchanges their payout dollars for a tokenized-Treasury instrument that exists on the same
   network. We build the transaction; the member signs it; we take no fee. This is the same
   mechanism as a swap feature we already ship.
   Note the instrument we have in mind is offered under Reg S and excludes US persons. **What
   standard of geo-fencing / US-person exclusion would you require of us**, given that we do not
   collect identity documents and would be relying on IP geolocation plus a member representation?
   If that is not sufficient, is variant (b) simply unavailable to us?

4. **Is variant (c) permissible, and is it a different animal?**
   *Variant (c) — bridged conversion.* The payout moves across networks inside a single flow and
   lands in a US-eligible partner's product. This is the deepest integration and the one we are
   least sure about: does building that flow make us the party "effecting" a securities
   transaction, even though the member signs and the partner executes?

5. **Does offering this change our answer to the licensing question in the main brief?** In
   particular, does facilitating a member's conversion of their own funds — with no custody and no
   fee — create money-transmission exposure that our current posture avoids?

6. **What must we tell members?** What risk disclosure, and in what form, does a member need to
   see before that optional screen? Our audience includes older, non-expert, and in some cases
   unbanked users, in English and French. We would rather over-disclose than under-disclose, but
   we need to know the floor.

7. **The collective version — is it a non-starter?** Separately and further out, members have
   asked whether the *group* could vote to place a cycle's pot into an asset held collectively,
   rather than rotating it to one member (in effect, an investment club). We assume this implicates
   securities and possibly investment-company law and that our answer is "not without a different
   legal structure." **Please confirm whether that instinct is right**, and if there is a viable
   structure, what it looks like at a high level. We are not asking for a design — only whether the
   door is closed.

## 4. What we need back

1. A yes / no / yes-with-conditions on **variant (a)**, since that is the only one we would build
   first, and the conditions we must meet.
2. A view on variants **(b)** and **(c)** sufficient for us to decide whether to keep them on the
   roadmap at all.
3. Required disclosure language, or the standard it must meet.
4. Confirmation that this feature does not disturb the licensing posture in the main brief.

**What happens next on our side.** If (a) is permitted we design it and ship it as an optional
screen in a later release, geo-segmented, with no compensation unless you have told us a specific
arrangement is safe. If (a) is not permitted, we drop the feature and say so publicly rather than
looking for a workaround.

---

## Appendix — factual background on the partners named

Provided so counsel can verify rather than take our word. Verified 2026-08-20; all are third
parties with whom we have **no** agreement or contact at this time.

| Partner | What it offers | Relevant status | Networks |
|---|---|---|---|
| Dinari | Tokenized US equities (dShares), incl. full S&P 500 launched 2026-08-04 for eligible US investors from self-custody wallets, USDC-settled | SEC-registered transfer agent; affiliate registered broker-dealer, FINRA/SIPC member | Ethereum, Arbitrum, Base, Avalanche (**not** our network) |
| Ondo (USDY) | Tokenized-Treasury-backed instrument | Offered under Reg S; **excludes US persons** | Live on our network |
| Kraken / Backed (xStocks) | Tokenized equities venue | Issued by a Jersey entity; not open to US persons on-chain | Multichain, **not** our network |
| Franklin Templeton (BENJI) | Share token of a US-registered money market fund | US-registered fund | Nine chains, **not** our network |
| Circle (CCTP) | Native cross-chain transfer of USDC | — | Live on our network; connects to Dinari's chains |

Two facts shape the variants above: **no tokenized equity is currently issued on the network we
run on**, and the one Treasury-backed instrument that is available there excludes US persons.
That is why the US-eligible route (variant c) requires a cross-network movement, and why the
simplest route (variant a) is a handoff rather than an integration.
