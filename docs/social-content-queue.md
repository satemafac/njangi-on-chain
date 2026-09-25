# Social content queue — weeks 1–2

_2026-08-29. Executes `docs/social-strategy-custody-wedge.md` against
`.agents/product-marketing.md` v2. Every post below is drafted to publish._

**Accounts:** X `@njangi_on_chain` (live) · Instagram `@njangionchain` (live) ·
TikTok (not yet opened — do this before week 1) · Facebook groups (listen only).

**Pillars:** Proof 30% · Tradition 25% · Contrast 20% · Build-in-public 20% ·
Product 5%.

## Pre-publish checks — do these once, before anything goes out

1. **Confirm the explorer URL.** Post 1.1 says "go read it yourself" and is
   worthless — worse, actively damaging — if the link is wrong. Get the live
   production package id and its Sui explorer URL, open it, confirm a stranger
   can see the function list. It is not in the public bundle, so read it from
   Vercel production env (`NEXT_PUBLIC_TESTNET_PACKAGE_ID`).
2. **Decide how to say "testnet."** Circles are real, money is not. Every post
   that implies live usage needs that qualifier, once, plainly. Suggested
   standing line: *"We're in testing — real circles, test money, on purpose."*
3. **Open the TikTok handle** before someone else takes `njangionchain`.
4. **Regenerate `/og/blog.png`** — it is the share card on three of the four
   articles.

## Hard rules — apply by hand, `check:copy` does not scan social

Never: blockchain · crypto · Sui · web3 · wallet · interest · returns · yield ·
earn · invest · guaranteed · savings account · "deposit" for the pot · any
quantified return · the word "audited" (no third-party audit exists — say "176
passing contract tests") · mobile-money cash-out · invented traction.

Never mock the notebook. Never name a competitor to attack.

---

# Week 1 — establish the claim

### 1.1 · X · **PINNED** · Proof
> Our contract has no function that lets us move a circle's money.
>
> Not "we promise not to." There is no code path. An admin key can't do it
> because the ability was never written.
>
> You don't have to believe me. It's a public ledger.
>
> [explorer link]

*Pin this. It is the account's thesis. Reply in-thread with the /learn link.*

### 1.2 · Reel + TikTok · 25s · Proof
```
[0-3s]  ON SCREEN: "Can they run off with your njangi money?"
[3-10s] Screen recording: open the contract, scroll the function list
[10-20s] VO: "Every function that moves money needs the member's own
         signature. There's no admin version. This is the whole list."
[20-25s] ON SCREEN: "Ask any savings app to show you this."
```
*Screen recording, no face. Cheapest asset you own and the most persuasive.*

### 1.3 · Instagram carousel · Tradition
> Njangi. Tontine. Susu. Chama. Stokvel. Esusu. Ajo. Equb. Hagbad. Pardna.
> Gameya. Kye.
>
> Twelve names. One idea: everyone pays in, one person takes the pot, it goes
> round.
>
> Nobody invented this. It appears independently on every continent, because
> it works.
>
> → njangionchain.com/learn

*One name per slide. This is the reach engine — shareable by people who will
never join a circle.*

**Assets (built):** slide 1 is the `nobody-holds-the-pot` animation; slides
2&ndash;11 are `marketing/assets/carousel-one-tradition.html`, which composites
generated grounds (`carousel/bg-weave`, `carousel/bg-cowrie`) under HTML type.
Images sit only on the opener and closer &mdash; a ground behind every slide
fights the typography, and the names accumulating in clean space *is* the
argument.

**Caption (approved 2026-08-29):**

> If your family runs one of these, you already know how it works.
>
> Everyone pays in the same amount. One person takes the whole pot. Next month
> it's someone else's turn, until everyone has had one.
>
> No bank invented that. It shows up in Cameroon as njangi, in Nigeria as esusu,
> in Kenya as chama, in Jamaica as pardna, in Mexico as tanda, in Korea as kye
> &mdash; in places that never met, in languages with nothing in common.
>
> What it never had was a record everyone could see. And one person who didn't
> have to hold the money.
>
> Swipe for sixteen of the names. Link in bio.

**First comment:** `Full glossary → njangionchain.com/learn` plus
`#njangi #tontine #susu #chama #stokvel #savingscircle`. The link goes here,
not in the caption &mdash; Instagram does not linkify captions, so a URL there
is dead text that costs reach. No fintech or crypto tags: they pull exactly the
audience strategy &sect;5 exists to avoid.

**Count discipline:** the carousel shows **sixteen** names (nine headline cards
plus Cundina, Hui, Arisan, Chit fund, Gameya, Committee, Pandero). The bio and
landing page say "twenty-five names". Keep any figure in copy matched to what
the asset actually shows &mdash; a first draft of this caption said twelve.

### 1.4 · X · Build-in-public
> Ran the contract suite this morning. 176 tests, 176 passing.
>
> Still on testnet. Real circles, test money, on purpose. Six circles running
> end to end so far.
>
> The boring number is the product.

### 1.5 · X thread · Proof + Contrast · **the strongest thing you have**
> 1/ In 2006 a British savings club called Farepak collapsed holding about
> £37 million of its customers' money.
>
> 2/ They were mostly low-income families paying in weekly, all year, for
> Christmas. The money had not been ring-fenced.
>
> 3/ When the company failed, those savers were — in the UK government's own
> later words — consumers who "do not have any special protections afforded to
> them." Unsecured creditors. Back of the queue.
>
> 4/ They had done nothing wrong. They saved diligently with a company that
> called itself a savings club.
>
> 5/ Here's the part worth knowing. Parliament didn't decide savings clubs
> should be licensed like banks.
>
> 6/ It decided the money should be held in trust — separated from the
> operator, so the operator failing doesn't take the savers with it.
>
> 7/ That's the whole lesson of twenty years of this. The question was never
> "is this scheme licensed?" It was "who is holding the money, and what
> happens when they have a bad year?"
>
> 8/ Worth asking of any savings app. Including ours.
>
> Full piece: njangionchain.com/blog/how-regulators-treat-savings-circles

*Real, cited, government-sourced. Makes the custody argument without you
making it. If one thing gets traction this fortnight, it is this.*

---

### 1.6 · Instagram Reel (+ TikTok re-upload) · 21s · Proof + Tradition · **nobody-holds-the-pot**

The animation that was dropped from 1.3 (Instagram rejects mixed video+image
carousels) becomes its own Reel. Not the 7s square loop &mdash; a 9:16 cut
with three acts, one cycle each, and the recipient moving one seat per cycle
(2 &rarr; 3 &rarr; 4). Rotation is the product, so the Reel shows the rotation
instead of describing it.

```
[0-7s]   CYCLE 1 · SIX MEMBERS        "Everyone pays in. One takes the whole pot."
[7-14s]  CYCLE 2 · SAME CIRCLE        "Next cycle, the next member."
[14-21s] CYCLE 3 · THE PART THAT MATTERS  "Nobody holds the pot. Not even us."
```

**Assets (built 2026-09-06):** `marketing/assets/nobody-holds-the-pot-reel.html`
&rarr; `marketing/assets/export/nobody-holds-the-pot-reel.mp4` (1080&times;1920,
24fps, 21s, silent) and `...-reel-cover.jpg` (frame at 17.5s: act 3, pot at
6/6, member 4 lit). Rendered with
`node marketing/tools/capture-animation.js --width 1080 --height 1920 --seconds 21`.
Top 260px and bottom 340px are kept clear for the Reels UI. Fully HTML-rendered,
no generative imagery &mdash; the AI label does **not** apply to this one.

**Caption (drafted 2026-09-06):**

> Six people pay in. One takes the whole pot. Next month, the next person.
>
> That's a njangi. Or a tontine, a susu, a chama, a stokvel, depending on where
> your family is from. It has worked for generations because everyone can see
> the pot.
>
> We built the same circle to run across borders, with one rule it never had
> before: nobody holds the pot. Not the organiser. Not us. There is no button
> anywhere that lets a company move a member's money, because that code was
> never written.
>
> Watch where the money goes. Member, pot, member. Nothing in the middle.
>
> How it works, in plain language: link in bio.
>
> #njangi #tontine #savingscircle #cameroon #diaspora

**Hashtag and tagging plan** &mdash; Instagram now treats caption text as
search keywords and recommends 3&ndash;5 hashtags; a 30-tag block reads as
spam to the ranking and to the organiser. So the reach work is in the words
(`njangi`, `tontine`, `susu`, `chama`, `stokvel`, `pot`, `family`, `borders`),
and the tags are few and exact:

| Where | What | Why |
|---|---|---|
| Caption (5) | `#njangi #tontine #savingscircle #cameroon #diaspora` | Two tradition names, the category, the country, the audience. |
| First comment | `How it works → njangionchain.com/learn` + `#susu #chama #stokvel #esusu #rosca` | The link (captions don't linkify) and the second tier of tradition names. |
| Location tag | **Douala, Cameroon** | Location surfaces the Reel in the city feed; the diaspora browses home, not Dallas. |
| Alt text | "Six members on a ring pay into a shared pot. Each cycle the full pot moves to the next member. No company in the middle." | Accessibility, and Instagram indexes it. |
| Tag people / collab | none | No partner or member has agreed to be tagged. Tagging strangers is the fastest way to look like spam. |
| Cover | `nobody-holds-the-pot-reel-cover.jpg` | The headline sits inside the centre square, so the grid crop keeps "Nobody holds the pot." |
| Audio | none from web | The web composer cannot attach library audio. If you want a trending sound, publish from the phone app; otherwise silent is fine &mdash; the text carries it. |

No fintech, crypto, money or "passive income" tags. They pull the audience
strategy &sect;5 exists to avoid, and a njangi organiser scrolling
`#savingscircle` is worth a thousand `#fintech` impressions.

**Copy check (by hand):** no interest / returns / yield / earn / invest /
guaranteed / savings account / deposit / audited / blockchain / crypto / wallet.
"older than any bank" (on screen, act 2) is a claim about the tradition, not
about us.

### 1.7 · Instagram Reel (+ TikTok) · 80s · Contrast + Tradition · **the poverty tax** — PUBLISHED 2026-09-13

Live at https://www.instagram.com/reel/DdPUCfqgW8Y/ (founder pressed Share on the
staged composer). Claude's 2026-09-23 check missed it (hidden-tab Reels grid);
Muse's account check caught it 2026-09-24 before a duplicate went out.

Farida Nabourema (Togolese human-rights activist; founder of the Africa
Bitcoin Conference) on Simply Bitcoin EP 1583, from 46:00. Her voice, five
short excerpts, over our typography. No footage: every frame of the source
carries Ledn and Simply Bitcoin branding, and her shirt carries a coin logo,
so footage would put three other brands and a banned word on our grid.
Audio-only excerpts with attribution keep the post ours.

```
[0-9s]    THE POVERTY TAX        "I call it the poverty tax. The poorer you are, the more expensive
                                  the traditional banking system is to you as a person."
[10-24s]  WHO THE BANK LEAVES OUT  70% unbanked · rural 95%  (counter)
[25-40s]  TOGO TO GHANA            money leaves Togo, goes to a bank in Europe, comes back (route animation)
[40-53s]  WHAT MOVING MONEY COSTS  $17B/yr · Europe ~2% vs Africa up to 16%  (bars)
[53-61s]  WHAT AFRICA ALREADY HAD  "when people are in need of a solution, they find their way to it on their own"
[61-76s]  ours, no VO              circle of trust → THE SAME CIRCLE, ACROSS BORDERS (pot cycle) → Nobody holds the pot. Not even us.
```

**Pipeline (built 2026-09-13):** `/watch` skill (bradautomates/claude-video,
audited, installed at `.agents/skills/watch`) pulled captions; local Whisper
(medium, word timestamps) aligned the words; `marketing/tools/build-kinetic-reel.py`
cuts + loudness-normalises the clips, lights each caption word as she says it,
renders through `capture-animation.js`, and muxes. Spec:
`marketing/assets/poverty-tax-reel.spec.json`. Output:
`marketing/assets/export/poverty-tax-reel/poverty-tax-reel.mp4`.

**Credit (revised 2026-09-13 at the founder's request):** the video opens on a
title card with her name, her title and the show, every scene is labelled
"Farida Nabourema, in her own words", and it closes on a credit card with her
full title, the show and the timestamp. The caption carries the same credit
line. Her real title contains a word we never use in our own copy; it stays,
because it is her title, not our claim, and trimming it would be the wrong
kind of careful. Every number on screen is hers and labelled as such.

**Caption:**

> "The poorer you are, the more expensive the bank is to you."
>
> Farida Nabourema calls it the poverty tax. In her own words: most Africans
> have no bank account. Money sent from Togo to Ghana, two neighbours, goes
> through a bank in Europe first. Africa loses over $17 billion a year to
> remittance fees. And when people need a solution, they find their way to it
> on their own.
>
> They already did. A circle of people who trust each other: everyone pays in,
> one takes the pot, it goes round. Njangi, tontine, susu.
>
> We built that circle to run across borders, with one rule it never had
> before: nobody holds the pot. No bank in the middle, no cut of the pot, no
> function that lets us move a circle's money.
>
> Voice: Farida Nabourema, Togolese human-rights activist and founder of the
> Africa Bitcoin Conference, from her interview on the Simply Bitcoin podcast
> (episode 1583). Short excerpts, used with attribution. The figures are hers,
> as stated. Full link in the comments. How it works: link in bio.
>
> #njangi #tontine #povertytax #remittances #diaspora

**First comment:** `Source: Farida Nabourema (founder, Africa Bitcoin
Conference) on Simply Bitcoin, episode 1583, from 46:00 →
youtube.com/watch?v=y37e9lgSgtU. Short audio excerpts used with attribution;
the figures are hers as stated in the interview.` then
`#susu #chama #stokvel #togo #cameroon`.

**Settings:** cover = the "poverty tax" quote frame (~5s); alt text = "Farida
Nabourema's words about the cost of banking in Africa, shown as text, ending
with a diagram of six members paying into a shared pot that moves to one
member"; AI label off (audio is a real recording, visuals are HTML); no
location tag (see the Douala discussion on 1.6: it narrows a global-diaspora
message and implies a presence we don't have).

---

# Week 2 — establish the contrast

### 2.1 · Reel + TikTok · 25s · Contrast — the organiser's version
```
[0-3s]  ON SCREEN: "The worst part of running a njangi isn't the money."
[3-12s] VO: "It's being the one who holds it. Being the one they ask.
        Being blamed when the book and somebody's memory disagree."
[12-22s] VO: "You can run the same circle without ever touching anyone's cash."
[22-25s] ON SCREEN: "Nobody holds the pot. Not even us."
```

### 2.2 · X · Contrast
> Every savings-circle app has to answer one question: who holds the money
> between contribution and payout?
>
> If the answer is "the company," your protection is their promise, their
> solvency, and their good quarter.
>
> Worth asking before you join any of them. Including ours.

### 2.3 · Instagram + X · Tradition — the organiser
> Somebody in every savings circle keeps the book.
>
> She knows who paid in cash and who sent it by phone. Who's short this month
> because of school fees. Whose turn got swapped last year and never swapped
> back.
>
> She's rarely called a treasurer. Often she's just the person whose house
> everyone comes to.
>
> → njangionchain.com/blog/women-led-savings-circles-africa

*Your highest-empathy piece. Aim it at the organiser persona directly.*

### 2.4 · X · Contrast — diaspora
> A remittance is one-directional.
>
> You send it, and that's your whole role. No turn coming. No say in anything.
> No record of having been reliable for eleven years.
>
> You're a source of funds. Your aunt, who never left, is a member.
>
> The circle stopped at the border for bookkeeping reasons — the money was
> cash and the record was a book, so somebody had to be physically there.
>
> Migration split the family. The bookkeeping decided who stayed in the group.
>
> → njangionchain.com/blog/african-diaspora-remittances

### 2.5 · X · Build-in-public
> Shipped this week: fixed six things our own site was claiming that weren't
> true. One told members they could fund with assets we don't support.
>
> Nobody reported it. We found it reading our own FAQ like a stranger would.
>
> If you're building something people put money into, go read your own copy
> cold. It's uncomfortable and it's worth it.

*Honest, differentiating, and it turns a mistake into evidence of the trait
you're selling. Do not name the specific assets — just the class of error.*

---

## Cadence

| | X | Reels/TikTok | Facebook groups |
|---|---|---|---|
| Weekly | 4–5 posts, 1 thread | 2 videos | 15 min, comment only |

Batch in one 90-minute block. The recurring asset that matters most: **one
20–30 second vertical screen recording per week showing something real in the
product.** Cross-posts unchanged to Reels and TikTok.

## Measure

Release-list signups is the only conversion that exists pre-launch. Track
profile visits → /learn or /blog → signup. Ignore follower count.

## What is deliberately absent

No asset-conversion or "your turn can buy something that lasts" — counsel-gated
and unannounceable. No mobile-money cash-out. No testimonials — none exist yet;
the pilot exit interviews in `.agents/product-marketing.md` are how you get the
first real one, and the organiser's verbatim on *"I never had to hold anyone's
money"* is the single most valuable asset this product can acquire.

---

# LinkedIn — added 2026-08-29

**No page exists yet. Create one before week 1.** Company page, not just a
personal profile — partners and press look for the company.

LinkedIn is a different instrument from X, so this is not a cross-post. It
rewards fewer, longer, first-person posts and punishes thread-style fragments
and hashtag stuffing. **Two posts a week is plenty.** No emoji bullets.

The regulation and organiser material is native to this register. The proof
posts and build-in-public numbers are not — leave those on X.

### L1 · Week 1 · The Farepak argument, long form
> In 2006 a British savings club called Farepak collapsed holding around £37
> million of its customers' money.
>
> The savers were mostly low-income families who had paid in weekly, all year.
> The money had not been ring-fenced. When the company failed, they became
> unsecured creditors — in the UK government's own later words, consumers who
> "do not have any special protections afforded to them."
>
> They had done nothing wrong. They saved diligently, with a company that
> called itself a savings club.
>
> What interests me is the fix. Parliament did not decide that savings clubs
> should be licensed like banks. It decided the money should be held in trust —
> separated from the operator, so that the operator failing does not take the
> savers down with it.
>
> That is the lesson of twenty years of consumer-savings regulation, and it is
> narrower than people expect. The question regulators kept arriving at was
> never "is this scheme licensed?" It was "who is holding the money, and what
> happens to it when they have a bad year?"
>
> We build software for rotating savings circles — njangi, tontine, susu — and
> that question is the one we designed around. It is worth asking of any
> savings product. Including ours.
>
> Written up here, with sources: njangionchain.com/blog/how-regulators-treat-savings-circles

### L2 · Week 1 · Founder POV — what we will not build
> A list of things our product deliberately cannot do:
>
> It cannot move a member's money. There is no operator function for it — not
> restricted, not written.
>
> It cannot take a cut of contributions or payouts. Revenue is a subscription
> for coordination features, never a percentage of anyone's pot.
>
> It cannot score members. No rating, no tier, no number. A savings circle
> works because your aunt vouched for you; turning that into a score is a
> different product with different politics.
>
> It cannot tell you it is compliant. That is a question for qualified counsel,
> not a marketing claim.
>
> Constraints like these are usually described as things you gave up. In this
> category they are the product. Most of what goes wrong with community savings
> money goes wrong because somebody in the middle had a capability they should
> never have had.

### L3 · Week 2 · The organiser's economics
> Across njangis, chamas, stokvels and tontines, the person holding the money
> is very often a woman — and the role has a job description nobody wrote down.
>
> She collects. Cash arrives in person, in different denominations, on
> different days, sometimes short. Until the pot is handed over it is in her
> house or on her phone.
>
> She chases. Every circle has a member who is late, and someone has to ask.
> That social cost is paid entirely by the person doing the asking.
>
> She remembers. Rotation order, the swap agreed in March, who paid double in
> June to cover July. In most circles that lives in one notebook and one head.
>
> She arbitrates. When someone says they paid and the book says otherwise, she
> decides — in front of people she will see on Sunday.
>
> The risk organisers name first is almost never theft. It is accusation. A
> circle runs for years on one person's reputation, and a single disputed cycle
> can end it — not because money went missing, but because there is no way to
> show that it did not.
>
> Two of those four jobs are bookkeeping problems wearing a social costume.
> Those are the two worth solving. The other two were never administrative.
>
> njangionchain.com/blog/women-led-savings-circles-africa

### L4 · Week 2 · Partner-facing, and honest about the gap
> An honest note on a gap in our product.
>
> In a rotating savings circle, the payout moment *is* the cash-out moment. For
> members in Cameroon that means mobile money — MTN MoMo or Orange Money.
>
> We do not have an integrated path there yet. Members follow a documented
> route through an exchange they already use. That is acceptable for a pilot
> and not acceptable at scale, and I would rather say so than imply otherwise.
>
> The constraint is real: the licensed partner with the best mobile-money reach
> in our corridor does not yet support the network our settlement runs on. We
> are working the problem in the order that keeps members in control of their
> own funds — which rules out the fastest version, where we hold the money in
> between.
>
> If you work on stablecoin payouts into Central Africa, I would like to talk.

*L4 doubles as partner outreach — the Yellow Card and Transak conversations in
`docs/mobile-money-without-custody.md` start with a post like this, not a cold
email.*

## LinkedIn rules

- Company page, not personal-only.
- 2 posts/week. Never cross-post an X thread verbatim.
- No hashtag blocks. One or two at most, or none.
- Links in the post body are fine here (unlike X) but put the argument in the
  post — assume nobody clicks.
- Same banned vocabulary. Same no-blockchain rule. Same "no third-party audit,
  so never say audited."
