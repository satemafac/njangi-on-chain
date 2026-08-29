# Social strategy — the custody wedge

_2026-08-24. Built on `.agents/product-marketing.md` v2. Pre-launch: testnet, no customers,
no citable traction. Every claim here is constrained by the Embargoed claims table in that doc._

---

## 0. The strategic problem

Four competitors already say "digital njangi" (NjangiPulse, Tontiin, EAA, Djangui) and one says it
with $60M and 8.5M users (MoneyFellows). *Digitising the tradition* is table stakes. Announcing it
louder is not a strategy.

**The one thing none of them can say: nobody holds the pot — including us.** Every competitor is a
company holding a float. That is not a feature difference, it is a structural one, and it is the
only claim in this market that cannot be copied without rebuilding the whole product.

## 1. The insight that makes it work on social

"Non-custodial" is an abstraction, and abstractions do not travel. But this product has something
almost no pre-launch company has:

> **The proof is public and anyone can check it.**

Testnet circles are on an open ledger. The contract has no admin path to a circle's balance, and
that is *inspectable by a stranger*. Competitors say "secure" and "transparent." Only this product
can say **"here is the link — go look for yourself, I'll wait."**

That inverts the usual pre-launch weakness. Normally you have no traction so you have nothing to
show. Here, the absence of customers does not matter, because the claim being demonstrated is about
the *mechanism*, not the userbase.

**Everything below is downstream of one rule: never assert the custody claim. Always demonstrate
it.**

## 2. Platforms — where this audience actually is

The default SaaS answer (LinkedIn + X) is wrong for this audience. Split by persona:

| Platform | Persona | Role | Priority |
|---|---|---|---|
| **X** — `@njangi_on_chain` *(live)* | The nephew; press; partners | Where "non-custodial" is *understood* as a differentiator without translation. Cheapest channel for a technical founder. | **Primary** |
| **Instagram Reels** — `@njangionchain` *(live)* | The nephew; diaspora | Vertical demo video. Same asset cross-posts to TikTok. | **Primary** |
| **TikTok** — *no account* | The nephew (22–35, Douala/Dallas) | Highest organic reach for the exact segment that installs things. Biggest gap in the current setup. | **Open it** |
| **Facebook groups** | The organizer (45–70) | Cameroon's dominant platform; hometown associations live in groups. **Not a broadcast channel — a listening and relationship channel.** Join and participate; do not post ads. | **Listen only, pre-launch** |
| **LinkedIn** | Partners, investors | Low volume. Use for the partner/counsel/ramp conversations, not for member acquisition. | Low |
| **WhatsApp** | Everyone | Where njangis already live — but it is the *product surface*, not a marketing channel. Do not market into it. | N/A |

**Focus two, seed one, listen in one.** X and Reels are primary; open TikTok and cross-post the same
vertical asset; be present in Facebook groups without selling. Spreading across five channels
pre-launch is the standard way to do none of them.

## 3. Content pillars

| Pillar | % | What it does |
|---|---|---|
| **The Proof** | 30% | Show the mechanism. Explorer links, live circle state, "check it yourself." The custody wedge, demonstrated. |
| **The Tradition** | 25% | Njangi/tontine culture, history, the twenty-five names. **The reach engine** — shareable, warm, and not about the product. This is what makes the account followable by someone not ready to sign up. |
| **The Contrast** | 20% | Custodial vs non-custodial, argued on mechanism. Never name a competitor to attack. |
| **Build in public** | 20% | 176 passing contract tests, 100+ testnet circles, what broke and got fixed. Credibility for the nephew, and honest about being pre-launch. |
| **Product / CTA** | 5% | The mainnet release list. Rarely. |

**Why Tradition is 25%** — the product content has a hard ceiling pre-launch because the interesting
claims are embargoed. Culture content has no ceiling, reaches the organizer *and* the nephew, and is
the only pillar that earns shares from people who will never join a circle. It is also the pillar
where the "twenty-five names" glossary already gives you 17+ posts of raw material.

## 4. Example posts

*(All pass the banned-vocabulary list and the no-blockchain rule. Use them as calibration, not
as a queue.)*

**The Proof — X**
> Our contract has no function that lets us move a circle's money.
>
> Not "we promise not to." There is no code path. An admin key can't do it because the ability was
> never written.
>
> You don't have to believe that. It's a public ledger — go read it.
> [explorer link]

**The Proof — Reel / TikTok, 25s**
> `[0-3s]` On screen: *"Can they steal your njangi money?"*
> `[3-10s]` Screen recording: open the contract on the explorer, scroll the function list.
> `[10-20s]` VO: "Every function that moves money needs the member's own signature. There's no admin
> version. This is the whole list — nothing is hidden."
> `[20-25s]` *"Ask any savings app to show you this."*

**The Contrast — X**
> Every savings-circle app has to answer one question: *who holds the money between contribution and
> payout?*
>
> If the answer is "the company," then your protection is their promise, their solvency, and their
> good quarter.
>
> Worth asking before you join any of them. Including ours.

**The Tradition — Instagram carousel**
> Njangi. Tontine. Susu. Chama. Stokvel. Esusu. Ajo. Equb. Hagbad. Pardna. Gameya. Kye.
>
> Twelve names. One idea: everyone pays in, one person takes the pot, and it goes round.
>
> Nobody invented this. It shows up independently on every continent, because it works.
>
> *(→ /learn)*

**Build in public — X**
> Ran the contract suite this morning: 176 tests, 176 passing.
>
> We're still on testnet. No real money yet, on purpose. 100+ circles run end to end, nothing lost.
>
> The boring number is the product.

**The Contrast — the organizer's version, Reel**
> `[0-3s]` *"The worst part of running a njangi isn't the money."*
> `[3-12s]` "It's being the one who holds it. Being the one they ask. Being the one blamed when the
> book and somebody's memory disagree."
> `[12-22s]` "You can run the same circle without ever touching anyone's cash."
> `[22-25s]` *"Nobody holds the pot. Not even us."*

## 5. Hard rules for every post

1. **Never say blockchain, crypto, Sui, web3, or wallet.** Positioning rule from strategy §5. If a
   post needs one of those words to make sense, the post is aimed at the wrong audience.
2. **Never use the banned vocabulary** — interest, returns, yield, earn, invest, guaranteed, savings
   account, or "deposit" for the pot. `npm run check:copy` **does not scan social**. Apply the table
   in `.agents/product-marketing.md` by hand, every time.
3. **Never say "audited."** No third-party audit exists. Say "176 passing contract tests" and
   "internally reviewed."
4. **Never claim mobile-money cash-out.** Not until a licensed partner is live and tested
   (`docs/mobile-money-without-custody.md`). It is the most-requested thing in the home market,
   which is exactly why the copy will drift toward it.
5. **Never imply a return, growth, or an amount becoming larger.** The product rotates money; it does
   not grow it.
6. **No invented traction.** No "thousands of users," no fake testimonials. Everything citable is in
   the Proof Points table.
7. **Never mock the notebook.** The pen-and-paper njangi is the incumbent and the audience's own
   practice. The pitch is that the practice was always right and the paperwork was the weak part.
8. **Do not name competitors to attack.** Argue the mechanism; let the reader apply it.

## 6. Cadence — realistic for a founder shipping a product

| | X | Reels / TikTok | Facebook groups |
|---|---|---|---|
| **Weekly** | 4–5 posts, 1 thread | 2 videos | 15 min, comment only |

**Batch in one 90-minute block per week.** Write five X posts and script two videos from the pillar
mix. Leave room for reactive posts.

The single highest-leverage recurring asset: **one 20–30 second vertical video per week showing
something real in the product.** Cross-posts to Reels and TikTok unchanged. Screen recordings of an
actual circle are cheaper to produce than talking-head content and are more persuasive, because they
are the demonstration rather than the claim.

## 7. First two weeks

**Week 1 — establish the claim.**
1. Pinned X post: the custody claim with the explorer link. *This is the account's thesis.*
2. Reel: the 25-second "can they steal your money" explorer walkthrough.
3. Tradition carousel: the twenty-five names → `/learn`.
4. Build-in-public: the 176-test post.
5. Open the TikTok account; cross-post the Reel.

**Week 2 — establish the contrast.**
1. X thread: *who holds the money between contribution and payout?* — the mechanism argument.
2. Reel: the organizer's version ("the worst part isn't the money").
3. Tradition post: one name, one story (Equb, Pardna, Hagbad — the glossary has the material).
4. Build-in-public: something that broke and got fixed.
5. Begin Facebook group presence — join, read, comment. No links.

**Measure:** profile visits → `/learn` → release-list signups. The release list is the only
conversion that exists pre-launch; treat signups as the single north-star metric and ignore
follower count.

## 8. Housekeeping before posting

- **Fix `/og/blog-traditional-savings-vs-blockchain.png`** — the share card filename and artwork lead
  with the framing §5 forbids. It will be the image on every share of that post.
- **Audit remaining `/learn` pages.** `rosca.tsx` (24 hits), `tontine.tsx` (17), `susu.tsx` (17),
  `what-is-njangi.tsx` (13) are still crypto-first, including a step that tells readers to "set up a
  cryptocurrency wallet (Sui Wallet recommended)" — which contradicts the no-seed-phrase promise
  that is a core differentiator. `/learn` itself is fixed; these are not.
- **Decide the TikTok handle** before someone else takes `njangionchain`.
