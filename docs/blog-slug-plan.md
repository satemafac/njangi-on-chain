# `/blog` cleanup and slug plan

_2026-08-24. Follows the `/learn` sweep. Precedent for every step already exists in this repo._

## The headline finding: it is not really a slug problem

`src/pages/blog/index.tsx` declares **five** articles. **One exists.**

| Card | URL | Status |
|---|---|---|
| Traditional Savings Circles vs. Blockchain | `/blog/traditional-savings-vs-blockchain` | ✅ 200 — real |
| How African Diaspora Communities Are Revolutionizing Remittances | `/blog/african-diaspora-remittances` | ❌ **404** |
| 5 Caribbean Entrepreneurs Who Built Businesses Through Digital Sou Sou | `/blog/caribbean-sou-sou-success-stories` | ❌ **404** |
| Women-Led Savings Circles: The Backbone of African Community Finance | `/blog/women-led-savings-circles-africa` | ❌ **404** |
| Navigating the Regulatory Landscape for Blockchain Savings Circles | `/blog/regulatory-landscape-blockchain-savings` | ❌ **404** |

Four of five cards are clickable links to nothing. **Good news:** `src/lib/seo-routes.ts` lists only
`/blog` and the one real article, so the sitemap never fed the ghosts to Google — this is a
user-facing broken-link problem, not a crawl problem.

**One title needs to die regardless of what happens to the rest:** *"5 Caribbean Entrepreneurs Who
Built Businesses Through Digital Sou Sou."* You have no customers. Publishing that would be
fabricated testimonial content, and on a product whose entire pitch is verifiable trust it is the
worst possible thing to be caught with. It cannot be written until five real entrepreneurs exist and
consent.

## Step 1 — Remove the four ghost cards *(do this first, independent of any slug decision)*

Broken links on a trust product are corrosive out of proportion to their number: a visitor checking
whether you are real clicks a headline and gets a 404. Delete the four entries from the `articles`
array in `src/pages/blog/index.tsx` and keep the titles in a backlog.

Of the four, the two worth eventually writing are **women-led savings circles** (true, culturally
central, needs no customers) and **the regulatory landscape** (you have unusually good material in
`docs/compliance-roadmap-cex-dex-non-kyc.md`). The remittances one overlaps `/learn`. The
entrepreneurs one is embargoed above.

## Step 2 — Rename the one real slug

**Current:** `/blog/traditional-savings-vs-blockchain`
**Proposed:** `/blog/traditional-savings-circles-vs-on-chain`

The page's own `<title>` is *already* "Traditional Savings Circles vs. On-Chain" — someone fixed the
title and left the slug behind. This aligns them. "On-chain" is acceptable where "blockchain" is not:
it is in the product name.

**The precedent is yours.** `next.config.js:224-226` already does exactly this for `/learn`:
```js
{ source: '/learn/blockchain-rosca',  destination: '/learn/rosca',   permanent: true },
{ source: '/learn/tontine-blockchain', destination: '/learn/tontine', permanent: true },
{ source: '/learn/sou-sou-crypto',     destination: '/learn/susu',    permanent: true },
```
with a comment recording that the old URLs were *"indexed and earning 475 impressions, so these
redirects are what carries that history across — do not remove them."* The same 308 carries this
article's history across.

**Execution — four files, one commit:**
1. `git mv src/pages/blog/traditional-savings-vs-blockchain.tsx src/pages/blog/traditional-savings-circles-vs-on-chain.tsx`
2. Update `path=` in that file's `<Seo>` prop.
3. `src/lib/seo-routes.ts` — update the `path` and `page` for the article entry.
4. `next.config.js` — add to the existing redirects array, beside the `/learn` three:
   ```js
   { source: '/blog/traditional-savings-vs-blockchain',
     destination: '/blog/traditional-savings-circles-vs-on-chain', permanent: true },
   ```
5. `src/pages/blog/index.tsx` — update the card's `id`, `href`, and `title` (the card currently reads
   *"…vs. Blockchain: What's the Real Difference?"*, which no longer matches the page).
6. Re-run `npm run test:seo` — the suite asserts sitemap/route parity and will catch a mismatch.

**Do not skip the redirect.** Without it the URL 404s and whatever ranking it holds is lost, which is
the one genuinely irreversible part of this.

## Step 3 — The blog index copy

Same sweep as `/learn`, not yet done:
- `h1` "Blockchain Savings Circle Blog"
- "…savings circles to blockchain-powered innovation."
- "New to Blockchain Savings Circles?"
- Link cards still titled "Blockchain ROSCA", "Tontine Blockchain", "Sou Sou Crypto" — these are the
  *old* `/learn` names, so they are stale twice over: wrong framing **and** superseded titles.
- "Get the latest insights about blockchain savings circles…"

## Step 4 — The OG image

`/og/blog-traditional-savings-vs-blockchain.png` is the share card on every share of the one real
article. Regenerate it with the new framing and name it to match the new slug. Until then, the image
carries the framing §5 forbids into every social share of the post — which matters more than the
filename, because it is the part people actually see.

## Recommended order

1. Ghost cards removed *(no decision needed, purely a fix)*
2. Blog index copy swept *(no decision needed)*
3. Slug rename + redirect *(one decision: approve the new slug)*
4. OG image regenerated *(design task)*
