# Product Marketing Context

**Document version:** v2
**Last updated:** 2026-08-24

> Source of truth for every marketing skill in this repo. Drafted from the codebase:
> `docs/product-strategy-beta-2026-08.md` (§0–6), `docs/compliance-roadmap-cex-dex-non-kyc.md` §A3,
> `README.md`, `src/lib/i18n.ts`, `src/lib/entitlement-gate.ts`, `src/content/rosca-terms.ts`.
> **Read "Words to avoid" before generating any copy — it is a compliance control, not a style note.**

## Product Overview

**One-liner:**
The savings circle your family already runs — with rules nobody can quietly break.

**What it does:**
A *njangi* (tontine / ROSCA) is a group that agrees on a fixed contribution and a rotation order:
everyone pays in each cycle, one member collects the whole pot, and it rotates until everyone has
had a turn. Njangi On-Chain runs that exact model with the treasury held in per-cycle escrow that
no operator can touch, a payout only the scheduled recipient can take, and reminders delivered
where the circle already lives — WhatsApp.

**Product category:**
Savings-circle (njangi / tontine / ROSCA) coordination software. The shelf is *community savings
groups*, **not** fintech, not crypto, not banking.

**Product type:** SaaS (subscription), non-custodial. Settlement on Sui; never named in marketing.

**Business model:**
- **Free** — 1 circle, 3 members. No WhatsApp suite, smart goals, or analytics.
- **Premium — $9.99/mo** — 5 circles, 20 members (the Move-layer `MAX_MEMBERS` ceiling), WhatsApp
  suite, smart goals, analytics. Payer is typically the diaspora organizer.
- **Never** a fee, cut, or spread on contributions, payouts, or swaps. Revenue is coordination
  software only. This is a legal invariant (CLAUDE.md #3), not a pricing preference.

## Target Audience

**Target "companies":** B2C — informal savings groups of 3–20 people. Church groups, hometown
associations, extended families, workplace circles. Cameroon and the wider CEMAC region, plus the
Cameroonian diaspora (US, France, Canada, Belgium, Germany).

**Decision-makers:** The circle organizer decides. Members follow her.

**Primary use case:**
Run an existing njangi without the organizer holding everyone's cash, and without the notebook
being the only record of who paid.

**Jobs to be done:**
- "Keep me from ever being accused of touching the money."
- "Let my family in Douala and my cousin in Maryland be in the same circle."
- "Tell people it's their turn without me chasing them every month."

**Use cases:**
- A 12-member hometown association rotating monthly contributions across two continents.
- A one-off collection (funeral, school fees, medical) via **goal pots** — no rotation, beneficiary
  fixed and visible from the moment the pot opens. Lower commitment; the natural *first* experience.
- An established nine-year-old circle joining **part-way through** its rotation (mid-rotation
  migration) instead of waiting months for a clean restart.

**Soft-launch cohort filter (beta, operator-specified):**
Not the whole market — the leading edge of it. Target circles that are **traditional in practice but
forward-thinking in outlook**: groups whose members are already frustrated that a system they value
is run on paper, and who think in years rather than cycles. In practice this means a circle where a
modernizer (often the nephew persona) has enough standing to propose a change *and* an organizer
open to being convinced. Screen for outlook, not age or tech-literacy.

The pitch to this cohort is continuity plus permanence: *the system your family has trusted for
generations, finally built to last as long as the tradition has.* Avoid "upgrade," "modernise," or
anything implying the tradition was deficient — the appeal is that the practice was always right and
the paperwork was the weak part.

## Personas

| Persona | Cares about | Challenge | Value we promise |
|---|---|---|---|
| **The organizer** (45–70, often a woman, social hub of a church or hometown association) — *the buyer, controls adoption completely* | Reputation, not technology. Being trusted. Not being embarrassed. | She holds the cash, chases late payers, and gets blamed when the notebook and memory disagree. Her fear is **embarrassment and liability**, not hacking. | You will never again hold your friends' cash, and you will never again be accused of anything. |
| **The nephew** (22–35, Douala or Dallas) — *the installer, growth engine and churn risk* | Speed, proof, not wasting his time. | Finds the njangi worthy but sleepy. Being reliable for three years earns him nothing he can show anyone. | Verifiable settlement, and a record of your reliability you can actually hold. |
| **The quiet member** (any age, often unbanked) | Getting their turn, intact, on time. | Decades of flawless payment history and nothing to show for it. | Proof you were reliable — held by you, shown to whom you choose. |

> One feature, two true descriptions. Escrow is *"nobody can run off with the pot"* to her and
> *"verifiable settlement"* to him. Never pick one voice — write both.

## Problems & Pain Points

**Core problem:**
The pot is real but the *record* is a notebook, and the *trust* is one person's reputation. When
memory and notebook disagree, the organizer is blamed. When she is honest and still accused, there
is no way to prove it.

**Why alternatives fall short:**
- **The notebook + cash treasurer** — one person holds the money and the record. No independent
  proof. Disputes resolve by seniority, not evidence.
- **A WhatsApp group + mobile money** — good for chatter, no structure. No escrow, no rotation
  logic, no enforcement. The screenshot *is* the ledger.
- **Banks** — demand ID, minimums, and branch access; do not model a rotation at all; exclude the
  unbanked by design.
- **Generic crypto apps** — demand a seed phrase and a volatile token *before* you can pay your own
  contribution. Wrong audience, wrong ritual, and they broadcast personal data on a public ledger.

**What it costs them:** Money genuinely lost or disputed; circles that quietly dissolve after one
bad cycle; a lifetime of reliability that converts into nothing.

**Emotional tension:** For the organizer — the dread of being *thought* a thief. For the member —
"if this goes wrong, can we get our money back?" Answer both directly; neither is a technology
question.

## Competitive Landscape

> Researched 2026-08-24. **The strategy doc's assumption that "the notebook" is the only real
> incumbent is out of date** — there are now at least four funded or shipping digital njangi/tontine
> products targeting this exact market, and one category giant.

**Direct — digital njangi/tontine, Cameroon-specific:**
- **NjangiPulse** — digitises the Cameroonian njangi; contributions by **MTN Mobile Money and Orange
  Money via NotchPay**, automatic rotation, every transaction recorded. *Falls short:* custodial —
  a company holds the float and can freeze or lose it; the member's protection is a promise, not a
  mechanism. **But it has the mobile-money in/out we do not.**
- **Tontiin** — iOS + Android, positions as "the leading platform for managing traditional African
  rotating savings groups with modern security and convenience." *Falls short:* same custody
  question; app-store distribution means no WhatsApp-native coordination.
- **Djangui 3.0** — Cameroon tontine platform, actively publishing SEO content on tontine
  modernisation. *Falls short:* competes on content, unverified product depth.
- **EAA (Entraide Amicale d'Afrique)** — launched June 2026, AI-automated tontine platform
  (entraidaa.app). Automates group placement, collection, draws, distribution, and member comms;
  **GPT-4o behavioural scoring**. *Falls short:* behavioural scoring on members is precisely the
  line our Circle Record refuses to cross — and it is an attack surface for us, not a feature gap.

**Direct — category giant:**
- **MoneyFellows** (Egypt) — **$60M+ raised, 8.5M users**, expanding into Morocco. The proof the
  category scales. *Falls short for us:* Egypt/North Africa focus, not CEMAC, not diaspora-spanning,
  and custodial by design.

**Secondary:** WhatsApp group + MTN MoMo / Orange Money, run by hand. No escrow, no rotation logic,
the record is a screenshot. **This is still what most of the market actually uses.**
**Indirect:** The pen-and-paper njangi with a cash treasurer. *The true incumbent — respect it.*
Falls short on proof and dispute resolution, never on trust or cultural fit. Never mock it.
**Indirect:** Banks. ID requirements, no rotation model, excludes the unbanked.
**Indirect:** Generic crypto/DeFi apps. Seed phrases, gas tokens, public PII, wrong audience.

**What this changes:**
1. **"Digitising the njangi" is no longer a differentiator.** Four products already say it. Our
   claim has to be the one none of them can make: *non-custodial* — nobody holds the pot, including
   us. Every competitor above is a company holding a float.
2. **Custody is the wedge.** Against a notebook, our pitch is *proof*. Against NjangiPulse or
   MoneyFellows, the pitch is *"and when their company has your money, what happens if it's gone?"*
   Make the comparison about mechanism vs. promise.
3. **Mobile money is a real gap, not a nitpick.** NjangiPulse has MTN MoMo and Orange Money in and
   out. We have neither (F9: integrated off-ramp absent). In the home market that is their advantage
   and our weakness — do not pretend otherwise, and do not promise a fix until a licensed partner is
   live (see Embargoed claims).
4. **EAA's behavioural scoring is a positioning gift.** They score members with an LLM. We refuse to
   score anyone, by design and on the record. That contrast writes itself for the privacy-conscious
   organizer.

## Differentiation

**Key differentiators:**
- **Nobody holds the pot — not even us.** Per-cycle escrow; only the scheduled recipient can open
  it; release is permissionless so nobody waits on an administrator. No operator key can move
  member funds — enforced in Move, not policy.
- **Members can stop the circle.** A member-initiated emergency stop: eligible-member vote, majority
  threshold, expiry window, any member executes once passed, plus automatic release if the organizer
  goes silent. *"We control our money"* — by the same show of hands the circle has always used.
- **No seed phrase, no gas token.** Sign in with Google / Facebook / Apple. Sponsored transactions
  are billed to the organizer's subscription, not the member.
- **It lives in WhatsApp**, in seven languages including Pidgin. No migration to a new chat surface.
- **Privacy as dignity.** No member identity documents are collected at all. Contact details are
  encrypted off-chain; only an opaque pointer is anchored on-chain. Never a name or number on the
  public record.
- **Mid-rotation migration.** An established circle can join part-way through its rotation.

**Why customers choose us:** It is the circle they already run, minus the two things that break it —
one person holding the cash, and one person holding the record.

## Objections

| Objection | Response |
|---|---|
| "So you hold our money?" | No. Each cycle's pot sits in escrow only the scheduled recipient can open. There is no button on our side that moves it — not for us, not for anyone. |
| "If something goes wrong, can we get our money back?" | Yes. Members vote to stop the circle and funds return. If the organizer goes silent, there's an automatic release path. It's the same show of hands you already use. |
| "Do I need to understand crypto?" | No. You sign in with the account you already have. No seed phrase, no token to buy first. |
| "Is this one of those money-doubling schemes?" | No. Nothing here pays a return and nothing grows. It's the same rotation your family already runs — your circle's own money, on a schedule. |
| "What if I'm not good with technology?" | It reminds you on WhatsApp, where your circle already talks. |
| "Why pay when the notebook is free?" | You don't pay to use your own money — contributing, claiming, and recovery are always free. The subscription covers bigger circles and the reminders that stop you chasing people. |

**Anti-persona — do not market to:**
- Anyone looking to grow, invest, or earn on their money. We do not offer that, and courting them
  breaks compliance invariant #4.
- Crypto traders and yield-seekers. Wrong product, and they poison the trust framing.
- Public fundraisers wanting a discovery feed. Goal pots are private and member-to-member by design;
  public solicitation walks into charitable-solicitation registration.
- **No paid UK-targeted marketing** (ads, influencer spend, UK landing pages) until counsel clears
  the financial-promotions analysis — promoting cryptoasset activity to UK consumers without an
  approved promotion is a criminal offence and reaches offshore firms (§A5).

## Switching Dynamics

**Push:** A disputed cycle. An accusation. A member who "already paid." The exhaustion of chasing.
**Pull:** Never holding the cash again. One circle across two continents. Reminders that aren't her.
**Habit:** The notebook works, mostly. The circle is mid-rotation. Everyone already knows the ritual.
*(Mid-rotation migration exists precisely to kill this objection.)*
**Anxiety:** "If the app breaks, is our money gone?" "Will the elders think I'm being reckless?"
"Am I handing our money to strangers?" → Answer with the stop-vote and the escrow, in plain language.

## Customer Language

**How they describe the problem:**
- "I'm the one holding everybody's money."
- "She said she paid. The book says she didn't."
- "The njangi died after that year."

**How they describe us:** *(no customer interviews on file — capture verbatim during the pilot cohort)*

**Words to use:**
njangi, tontine, savings circle, circle, the pot, your turn, rotation, round, share, contribution,
payout, members, organizer, "your circle's own money," schedule, coordination, the ledger everyone
sees, security deposit *(the on-chain collateral only — accurate and approved)*.

**Words to avoid — CI-enforced, and the rule extends to social, ads, and press where CI cannot see:**
| Banned | Why |
|---|---|
| interest, returns, yield, earn | Implies an investment return (§A3) |
| deposit *(as a noun for the pot)* | Deposit-taking characterization. "Security deposit" for collateral is fine. |
| savings account, interest-bearing, compound interest | Banking terminology |
| invest, investment, guaranteed | Securities / financial-guarantee language |
| any quantified return figure ("8% returns") | Quantified return claim |
| naming an investment product or its operations | Advertising a product you don't offer is the same disclosure problem as offering one |

> **Also avoid: "blockchain," "crypto," "Sui," "web3," "wallet" in marketing copy.** Not a compliance
> rule — a positioning rule from strategy §5. *"The moment the chain is the headline we compete with
> every crypto app for a crypto-curious audience, instead of competing with a notebook for an
> audience that has money to organize."*
>
> `npm run check:copy` only scans `src/pages`, `src/components`, `src/content`,
> `whatsapp-bot-backend/src/services`, and `src/lib/i18n.ts`. **Social posts, ads, and press are
> outside the guard — apply this table by hand.**

**Glossary:**
| Term | Meaning |
|---|---|
| Njangi | Cameroonian term for a rotating savings group |
| Tontine / ROSCA | The same model elsewhere; ROSCA = Rotating Savings and Credit Association |
| Circle | One savings group |
| Cycle / round | One contribution period ending in one payout |
| The pot | The full amount collected in a cycle |
| Turn | A member's scheduled cycle to receive the pot |
| Goal pot | A non-rotating collection toward a fixed, visible beneficiary |
| Security deposit | On-chain collateral posted at join. **The one approved use of "deposit."** |
| Circle Record | A member-held, verifiable statement of their contribution history. No score, no rating. |

**One tradition, twenty-five names** — for localization and social reach:
Chit fund, Tanda, Stokvel, Chama, Esusu, Paluwagan, Hui, Arisan, Equb, Ajo, Cundina, Gameya, Kye,
Pandero, Committee, Pardna, Hagbad.

## Brand Voice

**Tone:** Plain, warm, unhurried. Respectful of a tradition that predates us. Never breathless.
**Style:** Concrete and specific. Short sentences. Describe what the software *cannot* do as often as
what it can — the trust promise is a limit on power, not a feature claim.
**Personality:** Trustworthy, familiar, dignified, plainspoken, quietly rigorous.
**Never:** hype, urgency manufacture, emoji-stacking, "revolutionary," "disrupt," crypto-native
in-group language, or anything that reads as a money-making opportunity.

## Proof Points

**Verified engineering traction (safe to cite):**
| Claim | Status |
|---|---|
| **176 Move contract tests, 176 passing, 0 failing** | ✅ Verified by running `sui move test` on 2026-08-24. Re-verify before citing. |
| **100+ circles run end-to-end on testnet with no funds lost** | ⚠️ Operator's own record — no stress-test artifact in the repo. **Testnet circles are on a public ledger, so this is independently verifiable.** Before citing publicly, capture the evidence (circle IDs / explorer links) so a skeptic can check it. That turns a claim into a proof. |
| Internal multi-agent adversarial review; fund-logic criticals found and fixed | ✅ `docs/pilot-readiness.md`, `docs/gtm-readiness-review-2026-06-12.md` |
| No operator key can move member funds — enforced in Move | ✅ Structural, verifiable on-chain |
| Signing key never leaves the browser | ✅ Enforced by a build-failing test (`src/__tests__/no-key-transmission.test.ts`) |
| Fund flows are never paywalled — contribute/claim/withdraw/recover ignore the billing gate | ✅ Verified in the GTM sweep |

**🚫 The word "audited" — do not use it unqualified.**
`docs/mainnet-publish-scope.md:23`: *"NO PROFESSIONAL THIRD-PARTY AUDIT on contracts that will hold
real funds. Posture is internal multi-agent adversarial review + Move tests only."* In this market
"audited" means a paid third-party security audit with a published report. Using it for internal
review is a claim a single question destroys — and it is the one claim that, if challenged publicly,
takes the whole trust position down with it. **Say "internally reviewed" and "176 passing contract
tests." Say "audited" only when you can link the report.**

**Customers:** None yet. The soft-launch cohort is the first.
**Testimonials:** None yet — **and none may be written until real users say them.** What follows is a
capture plan, not copy.

**Testimonial capture plan** — target themes (operator-specified) and the questions that elicit them
as usable quotes. Ask these in the pilot exit interview; record verbatim; get written permission to
quote.
| Persona | Target theme | Question that elicits a usable quote |
|---|---|---|
| Organizer | Ease of use | "What did you expect to be hard that turned out not to be?" |
| Organizer | Less headache with reminders | "How many people did you have to chase this cycle, compared to before?" |
| Organizer | Self-managed / off her shoulders | "What changed about your role in the circle?" *(target: she stops being the bank)* |
| Member | Fully auditable | "Was there a moment you checked something for yourself instead of asking her?" |
| Member | Voice and vote | "How did it feel knowing the group could stop the circle by vote?" |
| Member | Trust shift | "What would you tell a cousin who thinks this is a scam?" |

> The organizer's verbatim on *"I never had to hold anyone's money"* is the single most valuable
> marketing asset this product can acquire. Design the pilot to capture it.

**Value themes:**
| Theme | Proof |
|---|---|
| Nobody holds the pot — **including us** | Per-cycle escrow, permissionless release, recipient-pull claim. No operator key can move funds — enforced in Move. **The one claim no competitor in the landscape can make.** |
| Members can stop it | Member-initiated recovery vote + automatic release if the organizer goes silent. Both live. |
| We never score you | No rating, no tier, no number. Explicit product refusal — direct contrast with EAA's LLM behavioural scoring. |
| No seed phrase | zkLogin via Google/Facebook/Apple; signing key never transmitted, enforced by a build-failing test. |
| We don't ask for your ID | No identity documents collected. Contact details encrypted off-chain, opaque pointer on-chain. |
| We never take a cut | No fee on contributions, payouts, or swaps. Fund-flow handlers never consult the billing gate. |
| Tested before trusted | 176 passing contract tests; 100+ testnet circles end-to-end with no funds lost. |

## Goals

**Business goal:** Convert a pilot cohort into paying organizers; validate the monetized flow before
mainnet cutover.
**Conversion action:** *Now* — join the mainnet release list (email capture on the landing page).
*After launch* — create a circle, then upgrade to Premium at the member/circle cap.
**Current metrics:** Testnet + Stripe sandbox. Billing gated off. ~3 live circles.

---

## Embargoed claims — do NOT market yet

| Claim | Blocked by |
|---|---|
| **"Your turn can become something you keep"** — payout converting into tokenized shares or Treasury-backed products. *This is the strongest hook in the strategy doc and it is **not in beta**.* | Counsel opinion. Sequencing rule: counsel question → written answer → design → build. Nothing announced before the opinion lands. |
| **"Bid for your turn"** (auctions) | No interface built; framing must read as *taking less now so others receive more later*, never as a rate. Counsel review of mechanics **and words**. Never launch in the same release as the asset feature. |
| **Cashing out to mobile money** | No integrated off-ramp. Do not advertise until a licensed partner is live and tested. |
| **Any traction or performance number** | Testnet only. |
| **Paid UK-targeted marketing** | §A5 financial-promotions analysis. |

## Changelog
*Newest first. One line per revision: what changed and why.*
- v2 (2026-08-24) — Closed three gaps: real competitor landscape researched (NjangiPulse, Tontiin, EAA, Djangui, MoneyFellows) — repositions custody as the wedge since "digitising the njangi" is now table stakes; verified traction (176/176 Move tests) added with an explicit ban on the unqualified word "audited" (no third-party audit exists); testimonial capture plan replaces absent testimonials. Added soft-launch cohort filter.
- v1 (2026-08-24) — Initial context, auto-drafted from the codebase (strategy §0–6, compliance §A3, README, i18n, entitlement gate). Positioning set to the beta-safe two-clause form; asset-conversion clause quarantined under Embargoed claims pending counsel.
