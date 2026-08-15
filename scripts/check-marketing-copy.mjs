#!/usr/bin/env node
// check-marketing-copy.mjs — CI guard for the marketing vocabulary
// standard (docs/compliance-roadmap-cex-dex-non-kyc.md §A3).
//
// The product is non-custodial coordination software with NO yield or
// investment features (the yield module was retired in the Phase 1
// compliance redesign). Banking/investment phrasing in user-facing copy
// invites deposit-taking / securities characterization — and worse,
// several pages once advertised the retired yield module as if it still
// existed. This script fails the build when banned PHRASES reappear.
//
// Phrase-level patterns, not single words: "security deposit" (an
// on-chain collateral term), "no interest charges", and risk DISCLAIMERS
// ("not ... a guarantee of returns", "consult ... before making
// investment decisions") are all legitimate and must not trip the guard.
//
// Wired into `npm run preflight` (and therefore .github/workflows/
// preflight.yml). Run standalone: `npm run check:copy`.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const SCAN_DIRS = [
  'src/pages',
  'src/components',
  // Marketing copy moved out of the page components and into data modules
  // (src/content/rosca-terms.ts). Without this line the glossary's ~6,500 words
  // of user-facing prose would sit outside the guard entirely.
  'src/content',
  'whatsapp-bot-backend/src/services',
];
const SCAN_FILES = ['src/lib/i18n.ts'];
const EXTENSIONS = new Set(['.tsx', '.ts', '.md']);
const IGNORE_DIRS = new Set(['api', '__tests__', 'node_modules']);

const BANNED_PATTERNS = [
  { re: /annual\s+returns?/i, why: 'implies an investment return' },
  { re: /\d+\s*(?:-\s*\d+\s*)?%[^.\n]{0,30}(returns?|yield|interest)/i, why: 'quantified return claim' },
  { re: /earn(?:s|ing)?\s+(?:interest|yield|returns)/i, why: 'yield/interest claim' },
  { re: /yield\s+(?:generation|strateg\w*|farming)/i, why: 'retired yield-module language' },
  { re: /defi\s+(?:integration|strateg\w*|yields?)/i, why: 'retired yield-module language' },
  { re: /compound\s+interest/i, why: 'banking terminology' },
  { re: /guaranteed?\s+returns?/i, why: 'financial guarantee language' },
  { re: /savings\s+account/i, why: 'deposit-taking characterization' },
  { re: /interest[-\s]bearing/i, why: 'banking terminology' },

  // --- Product-noun patterns -------------------------------------------
  //
  // Added 2026-08-02 after a live E2E found a full "YIELD ROUTING / Ember
  // Vault Operations" panel rendering on /circle/[id]/manage in production.
  // Every pattern above matches a CLAIM OF RETURN ("earn yield", "8%
  // returns"). That panel made no such claim — it simply NAMED a yield
  // product and its operations, so it sailed through a green check:copy.
  //
  // The backend already 410'd the actions, which is exactly why nobody
  // noticed: the feature was dead, the copy was not. Advertising an
  // investment product you do not offer is the same disclosure problem as
  // offering one, so these match product nouns, not promises.
  { re: /yield\s+routing/i, why: 'names a yield product (retired module)' },
  { re: /\bember\s+vault/i, why: 'retired Ember yield vault' },
  // Negative lookahead spares `suiUsdEquivalent`, a legitimate SUI->USD
  // price variable that /suiusde/i would otherwise flag on every page.
  { re: /suiusde(?![a-z])/i, why: 'retired yield-vault asset' },
  { re: /\brequest\s+redemption\b/i, why: 'vault redemption operation' },
  {
    re: /\bvault\s+(?:operations?|routing|deposits?|exposure|active)\b/i,
    why: 'names a vault product',
  },
  { re: /\bAPR\b/, why: 'annualized rate vocabulary' },
  // Invariant #1, not #4: "Withdrawal processing stays external/
  // operator-driven" describes the operator moving user funds — the exact
  // capability the CLARITY non-controlling test asks about.
  { re: /operator[-\s]driven/i, why: 'implies operator control of user funds' },

  // --- Over-claim patterns ---------------------------------------------
  //
  // Added 2026-08-04. Everything above governs the FINANCIAL vocabulary
  // (yield, interest, vaults). Nothing governed claims about SECURITY or
  // REGULATORY STATUS, so these sat in CI-green code for months:
  //
  //   "Our platform complies with applicable regulations"  (faq.tsx)
  //   "No single point of failure or fraud risk"           (learn/)
  //   "Custody risk: None" / "Coordinator risk: None"      (blog/)
  //   "Smart contract automation eliminates ... fraud"     (faq.tsx)
  //
  // Each was contradicted by the product's own risk disclosure ("Software
  // can have bugs… your circle members are your risk") and, in the
  // regulatory case, by docs/counsel-brief.md, which treats the posture as
  // an OPEN question pending an opinion letter. Self-certifying compliance
  // in public while asking counsel whether the posture holds is the single
  // highest-exposure sentence a pre-launch product can ship.
  //
  // The honest claims are also the stronger ones — "no treasurer holds the
  // cash" and "everyone sees the same ledger" are true, specific, and
  // exactly what a njangi member cares about.
  {
    re: /\b(?:complies|compliant|in compliance)\s+with\s+(?:all\s+)?(?:applicable|relevant|local)\s+(?:laws?|regulations?)/i,
    why: 'self-certifies a regulatory posture counsel treats as unresolved',
  },
  {
    re: /\b(?:eliminat\w+|remov\w+|prevent\w+)\s+(?:the\s+)?(?:risk\s+of\s+)?(?:fraud|theft|human error)/i,
    why: 'absolute security claim; contradicted by the risk disclosure',
  },
  {
    re: /\bno\s+(?:single\s+point\s+of\s+failure|fraud\s+risk|custody\s+risk|coordinator\s+risk)/i,
    why: 'absolute risk-elimination claim',
  },
  {
    re: /\b(?:custody|coordinator|counterparty)\s+risk:\s*none/i,
    why: 'absolute risk-elimination claim',
  },
  {
    re: /\bcryptographic\s+guarantees?\b/i,
    why: 'overstates what the contract guarantees',
  },
  {
    re: /\bensures?\s+fairness\b/i,
    why: 'unfalsifiable fairness claim',
  },
  // Payout order is set by the admin before activation and is visible on
  // chain. Calling it random is not an over-claim so much as a wrong
  // description of the product — and the FAQ contradicted itself about it.
  {
    re: /random\w*\s+(?:determine|select|assign|choose)\w*\s+(?:the\s+)?payout/i,
    why: 'payout order is admin-set and on-chain, not random',
  },
];

// Line-level whitelist: disclaimers and denials are the GOOD kind of
// mention — they negate the claim rather than make it.
const WHITELIST_PATTERNS = [
  /not\b[^.\n]{0,80}guarantee of returns/i,
  /no\s+(?:yield|interest)/i,
  /pays?\s+no\s+(?:interest|yield)/i,
];

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (!IGNORE_DIRS.has(entry)) walk(full, out);
    } else if (EXTENSIONS.has(path.extname(entry))) {
      out.push(full);
    }
  }
}

const files = [];
for (const dir of SCAN_DIRS) {
  const full = path.join(ROOT, dir);
  try {
    walk(full, files);
  } catch {
    // whatsapp-bot-backend may be absent in some checkouts — skip quietly.
  }
}
for (const file of SCAN_FILES) {
  files.push(path.join(ROOT, file));
}

const violations = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    if (WHITELIST_PATTERNS.some((re) => re.test(line))) return;
    for (const { re, why } of BANNED_PATTERNS) {
      const match = re.exec(line);
      if (match) {
        violations.push({
          file: path.relative(ROOT, file),
          line: idx + 1,
          phrase: match[0].trim(),
          why,
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error('[check:copy] banned marketing vocabulary found:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  "${v.phrase}"  (${v.why})`);
  }
  console.error(
    `\n[check:copy] ${violations.length} violation(s).\n` +
      '  Financial vocabulary: the product has no yield/interest features — see\n' +
      '  docs/compliance-roadmap-cex-dex-non-kyc.md §A3 for the approved framing.\n' +
      '  Security/regulatory claims: state what the contract actually does. The\n' +
      '  honest claim is usually the stronger one, and the risk disclosure in\n' +
      '  docs/legal-drafts/risk-disclosure.en.md is what the copy must not contradict.',
  );
  process.exit(1);
}

console.log(`[check:copy] clean — ${files.length} files scanned, 0 violations`);
