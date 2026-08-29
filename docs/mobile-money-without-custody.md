# Mobile money (MTN MoMo / Orange Money) without ever being in the flow

_2026-08-24. Answers the open question at `docs/product-strategy-beta-2026-08.md` §504 —
"Which licensed provider can actually deliver an exit to mobile money in our home corridor?" —
and resolves the **UNCONFIRMED** Yellow Card / Sui cell in
`docs/mainnet-softbeta-ramp-compliance-review.md`._

> Not legal advice. The control analysis below is the argument to put *to* counsel, not a
> substitute for their opinion.

---

## 0. The answer in one sentence

**The member signs every hop; we render a link.** Mobile money can appear in the product as
destination and origin without us ever being in the flow — provided we never hold an intermediate
balance, never hold a key that can move member funds, never call an API that instructs a payout,
and never take a cent that scales with the amount converted.

Everything below is the elaboration of that sentence, plus the awkward fact that the rails do not
currently line up.

## 1. Why "in the flow" is the wrong thing to be

The entire legal posture (CLAUDE.md invariants 1–3) rests on a control argument: FinCEN's 2019 CVC
guidance distinguishes money transmission on **independent control over the value**, not on whether
money moved or whether a business benefited. An anonymous-handoff design where the user retains
control throughout is a different regulatory animal from one where we can direct funds.

So the test for any mobile-money design is a single question, asked at every step:

> **At this instant, could Njangi — or anyone holding a Njangi credential — cause these funds to
> move somewhere the member did not sign for?**

If the answer is ever *yes*, even for twenty seconds, even in a contract we deployed and do not
intend to use, we are in the flow. Intent is not a control boundary. Capability is.

## 2. The pattern that works: guided handoff

This is not a new invention — it is exactly the pattern the strategy doc already chose for the
flagship asset feature (F1 variant **(a) Guided handoff**: *"an optional post-claim screen listing
eligible partners by country, tapping through to the partner's own flow. UX only: no funds routed,
no API, no fee, no ranking by payment"*). The same shape covers mobile money, and for the same
reasons.

**Tier 1 — Pure handoff. Ship this. ✅**
- After a member claims their payout, an optional screen: *"Cash out in Cameroon."*
- It deep-links to the licensed partner's **own hosted widget**, prefilled with the member's own
  address and their country. The member enters their MoMo number **on the partner's page**, and
  accepts the partner's terms with the partner.
- The member's counterparty is the partner, under the partner's licenses. We are a signpost.
- We pass: the member's own address, the asset, optionally the amount, the country. Nothing else.
- **No API call that moves value. No funds routed through us. No fee. No ordering partners by what
  they pay us.**

**Tier 2 — Indicative quote before handoff. Probably fine, ask counsel. ⚠️**
- Read the partner's public rates endpoint to show "≈ 1,240,000 XAF" before the member taps through.
- Read-only; no funds, no instruction. The risk is not money transmission, it is **reliance**: a
  quote that turns out wrong at the worst emotional moment. Must be visibly indicative, timestamped,
  and never described as a rate we offer.

**Tier 3 — Partner Payments API. Do not build. ❌**
- Yellow Card and similar partners expose a Payments API where you programmatically initiate a
  payout. Calling it means **we instruct the movement of a member's funds**. That is the money
  transmitter line, drawn in the brightest available ink, and it forfeits the posture that every
  other invariant is protecting.
- It will be tempting because it is the only version that feels seamless. Seamlessness is the
  symptom to watch for: in this product, *friction at the boundary is the compliance control.*

### The bridge hop is member-signed, and that is what saves it

Where a cross-chain step is required (§3), the burn/mint is a **transaction the member signs in
their own browser with their own zkLogin key**. We build the transaction; we cannot sign it. That is
structurally identical to the member-initiated Cetus swap already blessed under invariant #5
("member-initiated swaps only, no routing fee"), and it is enforced by the same property that makes
the escrow safe: our servers cannot produce a valid signature.

## 3. The rail reality — the rails do not currently line up

Verified 2026-08-24. **This is the part that makes it hard, and it is worth knowing before any
design work.**

| Partner | MoMo / Orange Money payout in Cameroon | Native USDC on **Sui** | Verdict |
|---|---|---|---|
| **Yellow Card** | ✅ Yes — MTN MoMo, Orange Money, bank; licensed in 20 African countries; widget **and** API | ❌ **No.** USDC on ERC20, CELO, BASE, XLM, SOL. Sui is not on the list. | Has the last mile, not the chain |
| **Transak** | ❓ Unconfirmed — markets "7+ local payment methods" for Cameroon but does not publish the list; public pages show cards / Apple Pay / Google Pay / bank | ✅ Yes — already wired (`transak-service.ts:97` sets `network=sui`) | Has the chain, last mile unknown |
| **Coinbase Offramp** | ❌ No — needs a full Coinbase account and linked bank | ✅ Yes — native USDC on Sui | Diaspora side only |
| **MoonPay / Transak Sell** | ❌ | ❌ Sui unsupported for sell | Dead end |

**This resolves the open cell in the ramp review: Yellow Card does not support Sui.** The doc's
question — "must verify Sui support with partner" — is answered in their public developer docs, and
the answer is no.

**Circle CCTP is the bridge, but Sui is on the slow path.** CCTP supports Sui, but **Sui runs V1
contracts only** — no Fast Transfer, no Hooks. CCTP V2 for Sui and Aptos was targeted for end of
H1 2026; it is now late August, so **verify current status before designing around it**. Base is a
full V2 chain, so `Sui → Base` is technically available today over V1, at V1 latency.

### Which gives two candidate routes

**Outbound (payout → XAF in a member's MoMo wallet):**
```
Sui USDC → [member-signed CCTP burn] → Base USDC → [Yellow Card hosted widget] → MTN MoMo / Orange Money
```
Two member-signed steps, one hosted partner flow, zero Njangi custody. Honest but not pretty — and
it arrives at the single most emotionally sensitive moment in the entire product.

**Inbound (MoMo → contribution) — possibly already solved:**
```
XAF via MoMo → [Transak hosted widget] → USDC delivered natively on Sui
```
**One hop, no bridge, and the integration already exists and is already geo-routed to CEMAC.**
This collapses to a config-and-confirmation question rather than a build.

## 4. The single highest-value question to ask this week

> **Does Transak Cameroon accept MTN Mobile Money and Orange Money as payment methods for a
> `network=sui` USDC purchase?**

If **yes**: inbound mobile money is solved with no new architecture, no bridge, no custody, and no
new partner — it is turning on a flag you already built and confirming a payment method. That is the
cheapest meaningful win available in the entire GTM surface, and it directly closes the gap that
NjangiPulse currently uses against you.

If **no**: inbound needs the same two-step Yellow Card + bridge shape as outbound, and the honest
answer for beta remains the documented Binance P2P path already shipped in `ReceiveFundsModal.tsx`
and `CashOutGuide.tsx`.

Transak does not publish country-level payment methods, so this is a partner question, not a
research question. Ask it directly.

Second question, to Yellow Card: **is native USDC on Sui on the roadmap, and on what horizon?** If
it lands, the outbound route loses its bridge hop and becomes a pure Tier-1 handoff.

## 5. The three traps

**Trap 1 — The intermediate balance.** Any design where USDC lands in an address, contract, or
account that Njangi controls, even momentarily, even as a "relayer" or "sweeper" or "batcher," is
custody. Batching members' bridge transactions to save gas is custody. A contract on Base that
receives and forwards is custody. The funds must go **address → address, member-signed at every
hop**.

**Trap 2 — The referral fee.** Every ramp offers partner revenue share, and it will be presented as
free money. Taking a per-conversion or volume-scaled cut is a fee on a fund flow (invariant #3), and
by the strategy doc's own reasoning about the asset partner it is *"economically a cut of a member's
payout and likely also implicates transaction-based compensation rules."* The doc's conclusion
transfers verbatim: **a flat, non-volume-based marketing arrangement is the only partner economics
counsel should even be asked about.**

**Trap 3 — Marketing ahead of the rail.** `product-strategy-beta-2026-08.md` §262 already sets the
rule: *do not advertise cashing out to mobile money until a licensed partner is live and tested.*
Mobile money is the most requested thing in the home market, which is exactly why the copy will want
to run ahead of the integration. It must not. See the Embargoed claims table in
`.agents/product-marketing.md`.

## 6. Recommendation

1. **Ask the two partner questions** (§4). They are emails, and one of them may collapse inbound to
   a config change.
2. **Ship inbound before outbound.** Inbound is one hop if Transak confirms; outbound needs a bridge
   and lands at the most sensitive moment. Sequence by risk, not by demand.
3. **Design outbound as Tier 1 only**, with the bridge as a member-signed step. Put the Payments API
   permanently out of scope in writing, now, before someone reasonably proposes it as a UX
   improvement.
4. **Verify CCTP V2 Sui status** before any outbound design work.
5. **Keep the existing P2P guidance shipping** in the meantime. It is honest, it works, and it
   costs nothing to maintain.

## 7. What this does to positioning

NjangiPulse's mobile-money integration is real and ours is not. But the comparison is not
like-for-like, and the difference is the whole pitch: **their MoMo rail exists because they hold the
float.** Custodial products can offer a smoother last mile precisely because they take control of
the money — that is the trade, and most members have never been shown it explicitly.

So the honest framing is not "we have mobile money too." It is: *"getting money out should be easy —
and it should never require handing your circle's money to a company. We are doing it the harder way
round, and here is exactly where we are."* That is a defensible position while the gap exists, and a
strong one once it closes. It is not defensible if we imply the gap is not there.
