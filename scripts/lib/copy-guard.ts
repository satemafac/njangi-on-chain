/**
 * The single-word half of `npm run check:copy` (scripts/check-marketing-copy.mjs).
 *
 * docs/compliance-roadmap-cex-dex-non-kyc.md §A3 bans "invest(ment)",
 * "returns" and "earn" in user-facing copy, and src/content/rosca-terms.ts
 * repeats the rule. The guard only matched phrases ("earn interest",
 * "annual returns"), so "invest in Bitcoin" or "earn more" passed CI.
 *
 * Single words cannot be matched line by line in source code: `return` is
 * a keyword on most lines, and comments are full of "returns null". So this
 * reads the user-facing text out of the source (string literals, template
 * text, JSX text; never comments, imports, type positions, object keys or
 * logging calls) and matches whole words there. The ordinary senses stay
 * legal: "learn" and "returned" are other words, "return the deposit" and
 * "deposit returns" are about giving money back, "what members earn" is
 * income, and a denial ("never offers an investment") is the disclaimer the
 * policy wants.
 *
 * Node runs this file directly (type stripping; the package.json next to it
 * marks the folder as ESM), and jest runs src/__tests__/scripts/copy-guard.test.ts
 * against it. Keep it erasable TypeScript: no enums, namespaces or parameter
 * properties, and no relative imports.
 */
import ts from 'typescript';

export interface TextSegment {
  text: string;
  /** 1-based line of the segment's first character. */
  line: number;
}

export interface CopyFinding {
  line: number;
  phrase: string;
  why: string;
}

/** Stands in for an interpolated value (`${x}`, `{x}`) inside a segment. */
export const PLACEHOLDER = '{…}';

const LOGGING_CALLEE = /^(?:console\.\w+|debugLog|logSuiReadError)$/;

function isInLoggingCall(node: ts.Node, sf: ts.SourceFile): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current)) {
      return LOGGING_CALLEE.test(current.expression.getText(sf));
    }
    if (ts.isBlock(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isNonCopyPosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isLiteralTypeNode(parent) ||
    ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) ||
    (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) ||
    (ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === 'require')
  );
}

/**
 * The user-facing text of a .ts/.tsx source. A template literal becomes one
 * segment, and so do the text children of a JSX element, with each
 * interpolated value replaced by PLACEHOLDER.
 */
export function extractUserFacingText(fileName: string, source: string): TextSegment[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const segments: TextSegment[] = [];
  // JSX text keeps its leading whitespace (newlines included), so it is
  // located from its full start; anything else from its first token.
  const lineOf = (node: ts.Node) =>
    sf.getLineAndCharacterOfPosition(ts.isJsxText(node) ? node.pos : node.getStart(sf)).line + 1;
  const push = (text: string, node: ts.Node) => {
    if (/[A-Za-z]/.test(text)) segments.push({ text, line: lineOf(node) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      let text = '';
      let first: ts.Node | null = null;
      for (const child of node.children) {
        if (ts.isJsxText(child)) {
          text += child.text;
          first = first ?? child;
        } else if (ts.isJsxExpression(child)) {
          if (child.expression) text += PLACEHOLDER;
        } else {
          text += ' ';
        }
      }
      if (first && !isInLoggingCall(node, sf)) push(text, first);
      // Children still hold string literals and nested elements of their own.
      node.children.forEach((child) => {
        if (!ts.isJsxText(child)) visit(child);
      });
      if (ts.isJsxElement(node)) visit(node.openingElement);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      if (!isInLoggingCall(node, sf)) {
        const text =
          node.head.text + node.templateSpans.map((span) => PLACEHOLDER + span.literal.text).join('');
        push(text, node);
      }
      node.templateSpans.forEach((span) => visit(span.expression));
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isNonCopyPosition(node) && !isInLoggingCall(node, sf)) push(node.text, node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return segments;
}

/** Markdown prose: code blocks and inline code blanked out, line numbers kept. */
export function extractMarkdownText(source: string): TextSegment[] {
  const text = source
    .replace(/^```[\s\S]*?^```/gm, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length));
  return [{ text, line: 1 }];
}

const NEGATION =
  /\b(?:not|never|no|nor|cannot|can't|can’t|isn't|isn’t|aren't|aren’t|doesn't|doesn’t|don't|don’t|won't|won’t|without)\b/i;

interface BareWordRule {
  word: RegExp;
  why: string;
  /** The ordinary senses: `before` is the sentence up to the word, `after` the sentence after it. */
  allowed: (before: string, after: string) => boolean;
}

export const BARE_WORD_RULES: BareWordRule[] = [
  {
    word: /\binvest(?:s|ed|ing|ment|ments|or|ors)?\b/gi,
    why: 'investment vocabulary (policy §A3: no invest/investment)',
    allowed: () => false,
  },
  {
    word: /\bearn(?:s|ed|ing|ings)?\b/gi,
    why: 'earn vocabulary (policy §A3: no earn)',
    // Income, not yield: "members earn in dirhams", "what you earn".
    allowed: (before, after) =>
      /^\s+in\b/i.test(after) ||
      /^\s+(?:a\s+living|wages?|salar(?:y|ies)|an?\s+income)\b/i.test(after) ||
      /\bwhat\s+(?:you|they|we|members?|people|each\s+member)\s+$/i.test(before),
  },
  {
    word: /\breturns?\b/gi,
    why: 'investment-return vocabulary (policy §A3: no returns)',
    // Giving money back or coming back: "return the deposit", "returns
    // tracked funds to their owners", "deposit returns", "in return for",
    // "return to the dashboard", and code inside a string ("return fract(").
    allowed: (before, after) =>
      /^[\s-]+(?:to|from|the|your|their|its|it|them|each|every|all|any|tracked|custody|security|deposits?|funds|money|later|home|back|you|paid|this|that|what|whatever|members?)\b/i.test(
        after,
      ) ||
      after.startsWith(` ${PLACEHOLDER}`) ||
      /^\s*[\w.]*\s*\(/.test(after) ||
      /\b(?:deposits?|batch|in|to)\s+$/i.test(before),
  },
  {
    word: /\bvaults?\b/gi,
    why: 'vault wording implies Njangi holds members\' money (owner rule: never "vault")',
    allowed: () => false,
  },
  {
    word: /\btreasur(?:y|ies)\b/gi,
    why: 'treasury wording implies Njangi holds members\' money (owner rule: never "treasury")',
    // Only the proper nouns of citations and sanctions copy: "Treasury
    // Committee", "Department of the Treasury", "HM Treasury", "U.S.
    // Treasury", "treasury.gov".
    allowed: (before, after) =>
      /^\s+(?:Committee|Department)\b/.test(after) ||
      /^\.gov\b/i.test(after) ||
      /\b(?:Department of the|HM|U\.S\.|US)\s+$/.test(before),
  },
];

/** Line-level denials the phrase patterns already accept. */
export const WHITELIST_PATTERNS: RegExp[] = [
  /not\b[^.\n]{0,80}guarantee of returns/i,
  /no\s+(?:yield|interest)/i,
  /pays?\s+no\s+(?:interest|yield)/i,
];

function sentenceAround(text: string, start: number, end: number): { before: string; after: string; sentence: string } {
  const boundary = /[.!?;](?=\s|$)|\n\s*\n/g;
  let sentenceStart = 0;
  let sentenceEnd = text.length;
  for (let match = boundary.exec(text); match; match = boundary.exec(text)) {
    const at = match.index + match[0].length;
    if (match.index < start) sentenceStart = at;
    else {
      sentenceEnd = match.index;
      break;
    }
  }
  return {
    before: text.slice(sentenceStart, start),
    after: text.slice(end, sentenceEnd),
    sentence: text.slice(sentenceStart, sentenceEnd),
  };
}

/**
 * Every banned single word in the segments, outside its ordinary senses and
 * outside a denial ("never offers an investment") in the same sentence.
 */
export function findBareWordViolations(segments: TextSegment[]): CopyFinding[] {
  const findings: CopyFinding[] = [];
  for (const segment of segments) {
    for (const rule of BARE_WORD_RULES) {
      rule.word.lastIndex = 0;
      for (let match = rule.word.exec(segment.text); match; match = rule.word.exec(segment.text)) {
        const start = match.index;
        const end = start + match[0].length;
        const { before, after, sentence } = sentenceAround(segment.text, start, end);
        if (rule.allowed(before, after)) continue;
        if (NEGATION.test(before)) continue;
        if (WHITELIST_PATTERNS.some((pattern) => pattern.test(sentence))) continue;
        const line = segment.line + (segment.text.slice(0, start).match(/\n/g)?.length ?? 0);
        const phrase = `${before.slice(-30)}${match[0]}${after.slice(0, 30)}`.replace(/\s+/g, ' ').trim();
        findings.push({ line, phrase, why: rule.why });
      }
    }
  }
  return findings;
}
