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
    `\n[check:copy] ${violations.length} violation(s). The product has no yield/interest features — ` +
      'see docs/compliance-roadmap-cex-dex-non-kyc.md §A3 for the standard and approved framing.',
  );
  process.exit(1);
}

console.log(`[check:copy] clean — ${files.length} files scanned, 0 violations`);
