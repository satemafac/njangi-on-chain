# Product strategy — beta soft launch

**Date:** 2026-08-20
**Status:** Proposal for review. Nothing here overrides `docs/compliance-roadmap-cex-dex-non-kyc.md`.
**Designed companion:** published as a private artifact (see the team artifact gallery,
"The Njangi That Owns Things").

> Not legal advice. Every regulatory item below is a question for qualified counsel, not an
> answer. Several are genuinely unsettled.

---

## 0. Thesis

Every njangi already produces two things of value: **a pot of money** and **a record of who is
reliable**. Traditionally the pot is spent within days and the record dies in a notebook. The
product's job is to make both **durable** — the pot can become an asset the member keeps, and the
record can travel with them.

That is the strategy. Sui's role is to be the ledger nobody can quietly edit and the settlement
rail that lets a Cameroonian aunt and her nephew in Maryland be members of the same circle. The
member sees names, amounts and dates. The word "blockchain" appears nowhere in the marketing.

## 1. The two-generation problem

A njangi contains both its most conservative and its most impatient members. A product that wins
only one of them dies.

- **The organizer** (45–70, often a woman, the social hub of a church or hometown association)
  controls adoption completely. Her fear is not hacking — it is *embarrassment* and *liability*.
  She holds the cash, chases late payers, and is blamed when the notebook and memory disagree.
- **Her nephew** (22–35, Douala or Dallas) is the one who installs things. He finds the njangi
  worthy but sleepy, and being reliable for three years earns him nothing he can show anyone. He
  is the growth engine and the churn risk.

The answer is not two products. It is one feature with two true descriptions: escrow is "nobody
can run off with the pot" to her and "verifiable settlement" to him; the flagship is "your turn
can buy something that lasts" to her and "my ROSCA turn buys index exposure" to him.

## 2. What we will not build

Stating this first is strategic, not defensive. Defensibility rests on a narrow claim: we are
software that coordinates a group's own money and never touches it.

- **No custody.** No operator key can move member funds — enforced in Move, not policy.
- **No fee on any fund flow.** Not on contributions, payouts or swaps, and — critically for the
  flagship — **no per-conversion rebate from an asset partner**, which is economically a cut of a
  member's payout and likely also implicates transaction-based compensation rules.
- **No fiat settlement by us.**
- **No product that pays a return.** We don't operate one, don't describe one; CI fails on the
  vocabulary (`scripts/check-marketing-copy.mjs`).
- **No credit score.** The Circle Record is a member-held statement of fact, never furnished by us.
- **No discretionary advice.** No recommending assets, no ranking partners by payment.

---

## 3. Features

Status reflects the repository as of this date. Each feature is analysed against the full
eleven-point rubric in the companion artifact; this document carries the substance in prose.

### F1 · Asset Njangi — the flagship

**Status:** Rung 1 built · Rungs 2–3 counsel-gated, not in beta.

The traditional payout evaporates — school fees, a funeral, a roof, a debt. The circle is
excellent at *accumulating* and has no opinion about *what happens next*. Filling that gap is the
largest product opportunity and the largest legal exposure, so it ships as a ladder.

| Rung | What | State |
|---|---|---|
| 1 | **The pot holds digital dollars.** Native Circle USDC settlement (`src/config/constants.ts`). Makes cross-border circles possible at all. | Built; in beta |
| 2 | **Your payout can become an asset.** At claim time the member may convert their own funds through a regulated third party — tokenized US equities, Treasury-backed products. Same legal shape as the existing member-initiated swap: member signs, partner executes under its licenses, we take nothing. | Counsel first |
| 3 | **The circle invests together.** Members vote a cycle's pot into a collectively-held asset instead of rotating it. Most culturally resonant, most legally loaded. | Long-term |

**Verified market position (2026-08-20).** Dinari launched 724 tokenized US stocks — effectively
the S&P 500 — for eligible **US** investors trading from self-custody wallets on 2026-08-04,
USDC-settled, via an SEC-registered transfer agent with a FINRA/SIPC broker-dealer affiliate. It
runs on Ethereum, Arbitrum, Base and Avalanche — **not Sui**. Ondo's USDY (Reg S, excludes US
persons) **is** live on Sui. Kraken's xStocks is multichain, not Sui, not open to US persons
on-chain. Franklin Templeton's BENJI spans nine chains, not Sui. Circle's CCTP **is** live on Sui.

Two conclusions: the flagship is **real and nameable today** — we can say "Apple shares" and point
at licensed venues — and **no tokenized equity lives on Sui**, so the asset rung must reach
off-Sui.

**Three delivery variants, in order of legal cleanliness:**

1. **(a) Guided handoff** — an optional post-claim screen listing eligible partners by country,
   tapping through to the partner's own flow. UX only: no funds routed, no API, no fee, no ranking
   by payment. **Start here.**
2. **(b) On-Sui conversion** — non-US members swap payout USDC into a Treasury-backed instrument
   already on Sui, one member-signed transaction. Requires transfer-restriction diligence and
   server-side geo-fencing of US persons.
3. **(c) Invisible bridge** — Sui → Base/Arbitrum via CCTP into the partner's US-eligible product.
   Deepest integration, highest broker-dealer adjacency. Only after (a) proves demand.

**Revenue: none from the flow, deliberately.** Per-conversion compensation would breach the
no-fee-on-flows invariant *and* invite broker-dealer analysis. The flagship's job is acquisition
and retention. A flat, non-volume-based marketing arrangement is the only partner economics
counsel should even be asked about.

**Regulatory:** securities law and broker-dealer registration (tokenized equities are securities);
investment-adviser status if we rank or suggest; Reg S geo-fencing; GENIUS Act (enacted) bars
issuers paying interest on payment stablecoins, reinforcing that rung 1 is a payment rail; state
money transmission if we ever touch the flow.

**Risks:** compliance (misdesigned, this converts us from software into an unregistered
intermediary); trust (a member whose assets fall will blame the circle, not the market); adoption
(older members may read it as gambling with the pot — must be strictly optional, never default);
technical (cross-chain movement at the most emotionally sensitive moment); operational (partner
outages and eligibility rejections at claim time).

> **Sequencing rule.** Nothing in rungs 2–3 gets designed, wireframed or announced before the
> counsel opinion. Order is: counsel question → written answer → design → build.

### F2 · The glass box — nobody holds the pot

**Status:** Built and live.

Each cycle opens an escrow that freezes the rules before anyone pays in. Only the scheduled
recipient can take the pot, and release can be triggered by anyone, so nobody waits on an
administrator. If a cycle never completes, money returns. No state exists in which funds are
stranded at an operator's discretion, because the operator has no such power.

The organizer's pitch is one sentence: *you will never again hold your friends' cash, and you will
never again be accused of anything.* That removes the greatest personal cost of running a njangi,
which is why she is the buyer.

Revenue: none, ever — charging for access to one's own money would destroy posture and trust
simultaneously. Regulatory: this design *is* the non-money-transmitter argument; FinCEN's 2019 CVC
guidance distinguishes on exactly the control question. Risks: contract defect risk is
concentrated here (paid audit before open mainnet is non-negotiable); "the code holds it"
reassures the nephew and unsettles the aunt — her reassurance comes from F3.

### F3 · The circuit breaker — members can stop the circle

**Status:** Built and live; UX reads as technical.

A member-initiated emergency stop: eligible-member vote, majority threshold, expiry window, any
member can execute once passed, plus an automatic release path if the organizer goes silent. This
converts "the computer controls our money" into "we control our money."

It is the honest answer to the older member's real question, which is never "how does the
encryption work" but "if this goes wrong, can we get our money back?" Yes — by the same show of
hands the circle has always used.

Risks: a stop vote during a live dispute is a support event needing a written playbook; quorum
rules need real-world testing in a *disengaged* circle, not just a crisis; members must know it
exists before they need it.

### F4 · Sign in like everything else, pay no gas

**Status:** Sign-in built · sponsorship built but gated (`GAS_SPONSORSHIP_ENABLED`) ·
**address-drift guard absent — highest-priority build.**

Two barriers normally kill this audience: writing down twelve words, and being told to buy a
volatile token before paying your own contribution. Both are solved. zkLogin through Enoki with
Google/Facebook/Apple; signing happens only in the member's browser. Sponsored transactions are
built, capped, and billed to the organizer's subscription rather than the member — quietly the
best business-model decision in the product, since the person with most to gain from smooth
operation pays for the friction removal.

**The gap.** Account access is one-way: no account-level recovery, and a change in identity
configuration can silently resolve a returning member to a *different* address with funds left at
the old one. No guard detects this. For a product promising "your money is safe," this is the most
important unbuilt item in the document.

Any recovery feature must keep control with members — a mechanism letting *us* reassign an account
would undo the entire posture.

### F5 · The circle lives where it already lives — WhatsApp

**Status:** Built · Meta template approval pending.

Njangis already run on WhatsApp. Any product demanding migration to a new chat surface asks a
60-year-old to change a daily habit for a monthly benefit, and loses. Ours pushes into existing
group life in seven languages including Pidgin, with routing data encrypted off-chain and only an
opaque pointer anchored on-chain.

This is also the most defensible thing to charge for — pure coordination value that never touches
a fund flow. It is correctly the Premium anchor.

Risks: outside a 24-hour window, non-template messages silently fail — the most dangerous failure
mode for a reminder product; consent records (TCPA-adjacent for US recipients) must be real;
over-messaging gets the number blocked; delivery must be idempotent or members get duplicate
notices about money.

### F6 · Goal pots — the collection that isn't a rotation

**Status:** Built and live (`move/sources/njangi_goal_pool.move`).

Communities running njangis also run one-off collections constantly, and those are *more*
dispute-prone than the rotation because there is no schedule to appeal to. The product now has a
purpose-built vehicle: contributions accumulate toward a goal, the beneficiary is committed and
visible from the moment the pot opens and cannot be changed by anyone, and cancellation or a
passed deadline returns contributors their own money.

Strategically this doubles reach without doubling surface, and is a natural *first* experience —
smaller commitment than a twelve-month rotation.

Regulatory: charitable-solicitation registration regimes attach to public fundraising for third
parties. Our design (private, member-to-member, no platform fee, no public solicitation) sits well
outside the sharp end — **a "discover public pots" feature would walk straight into it.**

### F7 · Bid for your turn

**Status:** Auction entry points exist in `njangi_circles.move`; **no interface.**

Bidding ROSCAs are traditional across much of Asia and appear in African and Caribbean
traditions. A member needing money early offers to take a smaller share now; the difference goes
to members who wait. It allocates urgency by rule instead of favoritism — one of the most common
sources of resentment in a fixed-order circle.

The contract functions exist with nothing in front of them. Building the interface is contained
work that unlocks a differentiated format and directly answers "why is my turn ninth?"

**Framing is the risk.** It must read as *taking less now so others receive more later* — the
traditional framing — never as a rate or a cost of borrowing. A discount-for-early-turn structure
can be characterized as lending with an implied rate, raising usury and lending-licence questions
in some states. Counsel review of both mechanics and words before it ships. Do not launch it in
the same release as the flagship.

### F8 · The Circle Record — proof you were reliable

**Status:** To build. Beta candidate. Data already exists on-chain; nothing surfaces it.

Millions have decades of flawless njangi payment history and nothing to show for it. The record
turns that into something a member holds and chooses to show: cycles completed, on-time
contributions, payouts received and honored, with a link anyone can verify against the public
ledger.

**What makes it safe is what it refuses to be.** No number, no rating, no tier. We send it to
nobody. The member exports and decides who sees it — a landlord, a cooperative, a new circle
deciding whether to admit them. That last use is immediately valuable and entirely internal:
*reputation portable between circles* is a strong reason to run your next circle here too.

**The line to hold is FCRA.** A company assembling consumer information and furnishing it to third
parties for credit, employment or housing decisions can become a consumer reporting agency. Not
scoring and not furnishing is what keeps us out. **If we ever push records to lenders, or a partner
uses them for underwriting, we are in a different regime and need counsel first.** Write the
refusal into the product spec — it will be requested by users and partners.

Beta scope: read-only — view, export, expiring share link. No third-party consumption.

### F9 · Money in, money out

**Status:** Transfer funding live · three licensed ramps built but flag-gated · **integrated
off-ramp absent.**

Three on-ramp integrations exist with signed sessions and verified webhooks, currently off, with
geo-aware routing that already knows Central African members need specific providers. Launch
funding is direct transfer from an exchange the member already uses.

**The honest weakness:** in a rotating savings product the payout moment **is** the cash-out
moment. Today members get a guided walkthrough for sending to an exchange; there is no integrated
withdrawal. Acceptable for a pilot cohort, not at scale in the home market. Coinbase's ramp
supports USDC on Sui natively for diaspora members (zero-fee USDC ramps are offered to
integrators); an African licensed provider with mobile-money reach is the right home-market
answer — **network support unconfirmed, so we promise nothing yet.**

Rule until then: do not advertise cashing out to mobile money until a licensed partner is live and
tested.

Low, predictable transaction cost is what makes a small contribution economic at all — the
strongest purely-technical argument for the chain.

### F10 · Privacy as dignity

**Status:** Built; member-facing framing missing.

A public chain is a permanent broadcast, and njangi membership can reveal what someone earns, who
they support, and when they are struggling. The build takes the right line: contact details
encrypted off-chain with an opaque on-chain pointer; attestations carry hashes and expiry, not
personal data; **no member identity documents are collected at all.**

What's missing is the articulation. "We do not put your name or number on the public record, and
we do not ask for your ID" is a competitive statement against both banks and generic crypto apps,
and older users respond to it strongly. It belongs in onboarding, not in a policy page.

On-chain data cannot be deleted — which is exactly why personal data must never go there. Test the
deletion pathway against a real request during the pilot.

---

## 4. The three strongest hooks

1. **The re-think — "When your turn comes, it doesn't have to stay cash."**
   The payout can move into tokenized shares or Treasury-backed products through licensed
   providers. Nothing in the category can say this. *Wins the nephew. Requires counsel. Not in
   beta.*
2. **The trust — "Nobody holds the pot. Not even us."**
   Per-cycle escrow only the recipient can open, plus a member vote to stop a circle and get money
   back. *Wins the organizer. Already built. Ships in beta.*
3. **The record — "Twenty years of being reliable, finally written down."**
   Verifiable history the member holds and shares on their own terms. *Wins the unbanked member.
   Cheap to build. Beta candidate.*

## 5. Positioning

> **NjangiOnChain is the savings circle your family already runs — with rules nobody can quietly
> break, and a turn that can become something you keep.**

"Already runs" claims continuity, not disruption. "Rules nobody can quietly break" states the trust
promise as a limit on power rather than a technology claim — and it is honest, describing what the
contract does rather than promising an outcome. "A turn that can become something you keep" is the
re-think, deliberately not claiming we provide the asset.

Neither "blockchain" nor "Sui" appears. The moment the chain is the headline we compete with every
crypto app for a crypto-curious audience, instead of competing with a notebook for an audience
that has money to organize.

## 6. Prioritized beta feature set

| Pri | Item | State | Why in beta |
|---|---|---|---|
| P0 | **Address-drift guard** | Build | A returning member silently resolving to a new address is a fund-loss bug. Highest priority in this document. |
| P0 | Escrow, contribute, claim, recover | Built | The product. |
| P0 | Social sign-in | Built | Without it there is no non-technical user. |
| P0 | Counsel opinion on the posture | In flight | The gate: no real family money before it lands. Also unblocks flagship design. |
| P1 | Sponsored gas | Flip flag | Removes the "buy a token first" barrier. Prerequisite: key rotation, which is an address-migration event — do it before users exist. |
| P1 | WhatsApp reminders and turn notices | Template approval | Retention mechanism and Premium anchor. External dependency — start now. |
| P1 | Digital-dollar settlement | Built | Rung 1 of the flagship. |
| P1 | Goal pots | Built | Second, lower-commitment entry point. |
| P1 | **Mid-rotation migration** | In flight (`src/lib/circle-migration.ts`) | Lets a nine-year-old njangi join *part-way through its rotation* — members who already collected stay collected, ratified by every member. This is a larger adoption unlock than it looks: without it, an established circle must wait months for a clean restart, which is the single most common reason a working group defers switching. |
| P2 | Circle Record v1 | Build | Cheap, differentiated; makes the pilot's cycles worth something afterward. |
| P2 | Recovery-vote UX polish | Design | Answers the organizer's real fear — must read as plain language. |
| P2 | Privacy explainer in onboarding | Copy | Engineering done, competitive statement unmade. One screen. |
| P3 | Guided exit walkthrough | Built | Honest interim answer, shipped with expectation-setting. |
| — | Asset conversion, auctions, live billing | **Not in beta** | Auctions need framing review; asset conversion needs the opinion; billing stays off while the cohort is invited and small. |

## 7. Twelve-month roadmap

Two rules: legal work is on the critical path and starts immediately, and no quarter introduces
both a new money surface and a new regulatory question at once.

**Q1 · Sep–Nov 2026 — prove it works with real people**
Testnet pilot (5–15 invited, no real money) · ship the address-drift guard · counsel opinion lands
· templates approved and sponsorship enabled · Circle Record v1 · **open the flagship counsel
question** with a written scope for member-directed asset conversion.

**Q2 · Dec–Feb 2027 — real money, small and capped**
Allowlisted mainnet (≤15 members, per-circle caps) · paid contract audit · subscriptions on ·
first licensed on-ramp per corridor · off-ramp partner selection and network confirmation · asset
conversion design begins *only if* counsel has answered.

**Q3 · Mar–May 2027 — the re-think ships**
Open beta subject to audit · **asset conversion, guided-handoff variant**, geo-segmented ·
integrated exit path in at least one corridor · bidding circles piloted with one circle after
framing review · organizer-side member vetting using consented records.

**Q4 · Jun–Aug 2027 — depth and durability**
Deeper asset integration if the handoff shows demand · member-controlled account recovery · second
language market on evidence · scope the collective investment format with counsel (design only) ·
decide on partner-led lending referrals, or refuse permanently.

## 8. Beta architecture

Four layers; the member only ever sees the first, and the boundary between the third and fourth is
where the legal posture lives.

```
Member surface   web app · WhatsApp messages · social sign-in · 7 languages
       ↓  signs in browser, never on our servers
Coordination     transaction builder · sponsored-gas broker · notification scheduler
                 · sanctions screen · legal acceptance
       ↓  builds transactions the member signs — we can never sign for them
Sui              Circle · Cycle escrow · Goal pot · Membership · Recovery vote
                 · Attestation · USDC / SUI
       ↓  everything personal stops here and goes sideways
Off-chain        encrypted contact data · join queue · subscriptions · audit logs
                 · licensed ramps · asset partners
```

Three properties matter more than any component: **we hold no key that can move member funds**;
**no personal data is on the ledger**; **fiat never enters our systems**. Those three sentences are
the architecture and the legal argument at once — the sign that the design is right.

## 9. Organizer onboarding journey

Mama Grace, 58, runs a 12-woman njangi in Douala, keeps it in a hardcover notebook, holds cash in a
locked tin. Her daughter in Maryland wants to join but sending money is expensive. She has never
owned a cryptocurrency and does not intend to. Success is not that she understands the system —
success is that she finishes, and nothing along the way makes her feel foolish.

1. **Her daughter sends a link in the family group.** She opens it inside WhatsApp. French,
   mentions njangi by name, shows a contribution list that looks like her notebook.
2. **She signs in with Google.** One tap, the account she uses for email. No password to invent, no
   words to write down, no app store.
3. **She reads what the app promises and refuses.** Plain French: the money is held by the rules,
   not by us; we never ask for your ID; your number is never published. Terms accepted and recorded.
4. **She copies her njangi into the app — mid-rotation.** Twelve names, 25,000 XAF monthly, the
   order the group agreed. Crucially she does not have to wait for January: she records that four
   members already collected this round, and the app resumes at position five once every member
   confirms it. The circle switches without losing its place.
5. **She invites the group the way she always does.** A link into the WhatsApp group. Two members
   need help; the app's messages do the explaining, not Grace.
6. **The first month runs itself.** Reminders three days before. She sends nobody a reminder. *This
   is the moment she becomes a customer.*
7. **The first payout arrives.** One tap by the recipient. Grace doesn't count cash, doesn't carry
   it, isn't thanked — and also isn't blamed for anything.
8. **Someone asks the real question.** "What if the app disappears?" She shows them the vote: any
   majority can stop the circle and get contributions back, without her and without us.

**The constraint this implies:** nowhere in those eight steps does Grace meet a wallet, a seed
phrase, a token symbol, a network name, a gas fee, or the word blockchain. If a beta screen breaks
that, the screen is wrong — not Grace.

## 10. Messaging

Two banned categories, both enforced in CI. **Return language** (interest, yield, returns,
earning) because we offer no such product and describing one we don't offer carries the same
disclosure problem as offering it. **Absolute claims** (eliminating fraud, no risk, compliant with
regulations) because they contradict our own risk disclosure and self-certify a posture counsel
hasn't confirmed.

| Never | Instead |
|---|---|
| Earn returns on your savings while you wait | Your contributions sit in the circle's own pot until it's your turn. Nothing is lent out, and nothing is invested by us. |
| Blockchain eliminates the risk of fraud | No one — not your organizer, not us — can move the pot. Only the member whose turn it is can collect it. |
| A fully compliant, bank-grade platform | We're coordination software. We never hold your money, and we never touch cash — licensed partners do that part. |
| Build your credit score with every contribution | Every completed cycle adds to a record of your contributions that you keep and share with whoever you choose. |
| Grow your payout with high-performing digital assets | When your turn comes, you can keep it as dollars, send it out, or open an account with a licensed provider. Your choice, your money — and values can go down as well as up. |
| Connect your wallet to join a circle on Sui | Continue with Google. |

Every affirmative line above was run against `scripts/check-marketing-copy.mjs` and passes with
zero matches. The "Never" column trips the guard by design — do not paste it into an interface
file. The flagship's copy needs particular care: the words that sell it most naturally are the ones
most likely to describe a return, so partner-facing language must stay attributed to the partner
and never phrased as our offer.

## 11. Why not cash, a spreadsheet, a bank, or a wallet

| Today | Does well | Cannot do |
|---|---|---|
| Cash and a notebook | Universal, no technology, no fees, culturally rooted, works unbanked | Someone must hold the money and the suspicion. No member abroad. No record anyone accepts. One lost notebook ends nine years. |
| A WhatsApp group | Everyone is already there, free, instant | Coordinates conversation, not money. Nobody can prove who paid. Organizer still holds funds. |
| A spreadsheet | Arithmetic right, history visible | Editable without trace, so it settles no dispute. Still needs someone holding cash. Excludes the least technical. |
| Bank / mobile money | Regulated, insured deposits, cash-out solved | Doesn't offer rotating circles. Cross-border cost and delay. Excludes the unbanked. Never converts informal history into standing. |
| A crypto wallet | Self-custody, low transfer cost | Seed phrases, gas tokens, jargon — loses the audience at screen one. No concept of a circle, turn, vote or reminder. |

**The moat** is the combination of a non-custodial architecture with a consumer product that hides
it. A fintech could build the coordination features but not without becoming a custodian and
inheriting money-transmission obligations across every corridor — which is why none has. A crypto
team could build the contracts in a month, but not the seven-language messaging, geo-aware licensed
ramp routing, sanctions controls, cultural specificity, or organizer relationships.

## 12. Metrics

A pilot of fifteen cannot produce a meaningful funnel. It can produce something more useful: an
unambiguous answer to whether a circle completes.

**Activation** — organizer completes setup in one session (≥70%); invited member signs in and joins
(≥60% of invites, the best onboarding-friction measure); first open → first contribution (<15 min
median).

**Trust** — members who can correctly say who controls the pot (≥80%, asked in interviews); support
contacts about missing or stuck funds (target zero, investigated individually, not a rate); members
who know the stop-vote exists before needing it (≥70%).

**Payment reliability** — on-time contributions without a reminder (baseline month one, improve
after); contributions after one reminder (the direct measure of what the subscription buys); cycles
reaching full funding (≥95%).

**Successful payouts** — collected within 48h of availability (≥90%); failed or retried claims
(<2%, every one a trust incident); members who successfully move funds out when they want to (the
exit-gap early warning).

**Retention** — circles starting a second rotation (**the north star**); members retained into the
next rotation (≥85%); organizers active at 90 days (subscription viability).

**Growth and flagship** — second circle by an existing organizer (strongest signal the product is
essential, not tolerated); members who invite someone; payouts converted to an asset once available
(share of eligible payouts); share of new members under 35 (whether the re-think reaches the second
generation).

## 13. Regulatory register

| Standing | What | Why it matters |
|---|---|---|
| **Enacted law** | GENIUS Act (stablecoins, signed 2025-07-18) | Federal framework for payment stablecoins; agency rulemaking in progress through 2026, effective on final rules or Jan 2027. Bars issuers paying interest — supports the dollar token as a payment rail, not a return product. *We are not an issuer.* |
| **Enacted law** | BSA / OFAC sanctions | Prohibitions apply regardless of licensing. Our screening is a defensive control, not a licensed program, and must stay default-on. |
| **Enacted law** | State money transmission statutes | The reason no-custody, no-fiat is non-negotiable. |
| **Enacted law** | Securities laws, *Howey* line | Governs the flagship. Tokenized equities are securities. A pooled circle investing collectively is squarely in the analysis; rotating a pot back to its own contributors is not — that distinction is the whole design. |
| **Enacted law** | Fair Credit Reporting Act | The boundary the Circle Record must not cross. |
| **Formal guidance** | FinCEN 2019 CVC guidance | Clearest official articulation that a person who never controls user funds is not a money transmitter. Backbone of the posture — guidance, not statute; counsel must confirm it fits our design. |
| **Formal guidance** | SEC investment-club framing | Starting point, not conclusion, for any collective investment format. |
| **Pending — NOT law** | Digital asset market structure (CLARITY Act) | Passed the House, cleared Senate Banking; a procedural Senate vote was scheduled for 2026-09-15 and passage this year is far from certain. **Nothing in this plan may assume it becomes law.** |
| **Counsel required** | Asset conversion at payout | Broker-dealer adjacency, adviser status, Reg S geo-fencing, whether any partner arrangement is compensated solicitation. |
| **Counsel required** | Bidding circles | Whether discount-for-early-turn is characterized as lending; state lending and usury implications. |
| **Counsel required** | Consumer protection and messaging consent | How the product is described to non-experts; consent for business-initiated messages to US recipients. |
| **Counsel required** | Tax reporting | Converting a payout creates events we don't report and shouldn't advise on. Where does education end and advice begin? |
| **Counsel required** | Privacy across jurisdictions | State privacy statutes plus GDPR/UK-GDPR; deletion rights versus an immutable ledger. |

## 14. Open questions

1. **Will a US-eligible tokenized-equity provider deploy to Sui, or must we bridge?** None is on
   Sui today; the leading US-eligible venue is mid-expansion across four other chains. Being their
   Sui distribution partner is a genuine strategic position. Worth a direct conversation this
   quarter, and worth asking the Sui Foundation for the introduction.
2. **What exactly makes a member "eligible" at the partner, and how many of ours are?** If
   eligibility excludes most diaspora members or needs documentation our audience lacks, the
   feature is a demo. Establish before any design work.
3. **Which licensed provider can actually deliver an exit to mobile money in our home corridor?**
   The strongest African candidate's Sui support is unconfirmed. Highest-value unsigned partnership
   in the plan.
4. **Does the recovery vote work when a circle is disengaged rather than in crisis?** A quorum rule
   assuming attention may fail exactly when needed. Test deliberately in the pilot.
5. **Is the subscription payable by the person we think it is?** The model assumes a diaspora
   organizer with a working card. If the real organizer is usually the home-market elder and the
   diaspora member merely contributes, payer and buyer are different people and the packaging needs
   rethinking. Ask before building around the answer.
