/**
 * NJA-2847 — Deposit wording must name the three ways the deposit comes back.
 *
 * The contract (move/sources/njangi_circles.move) returns a security deposit
 * only to the member who posted it, and only in three ways:
 *   1. the organizer removes the member while the circle is NOT active
 *      (admin_remove_member / admin_remove_member_asset abort with
 *      ECircleIsActive on an active circle);
 *   2. the circle is stopped and the member claims their own refund
 *      (claim_own_refund aborts with E_CIRCLE_NOT_STOPPED otherwise);
 *   3. a recovery is executed and refunds every member (execute_recovery).
 *
 * A member of a running circle cannot leave, and there is no "good
 * standing", so copy that calls the deposit "refundable" on leaving, in good
 * standing, or with no condition at all promises a return the contract never
 * makes. Each string checked here must say the deposit comes back, must name
 * all three ways, and must name no other (no planned close, no leaving).
 *
 * The .tsx pages are checked as source text, the way
 * src/content/__tests__/whatsapp-updates.test.ts checks its components: jest
 * runs in `node` without a DOM and collects only `.test.ts`. The i18n strings
 * are read from DICTIONARIES (EN and FR).
 */
import { readFileSync } from 'fs';
import path from 'path';
import { DICTIONARIES } from '../../lib/i18n';

type Lang = 'en' | 'fr';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(path.join(SRC, rel), 'utf8');

/** One sentence on one line: collapse JSX indentation and line breaks. */
const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Drop JSX tags so only the rendered text (and inline expressions) remains. */
const untag = (jsx: string): string => flatten(jsx.replace(/<[^>]+>/g, ' '));

// ---------------------------------------------------------------------------
// The wording rules
// ---------------------------------------------------------------------------

/** The string says the deposit comes back at all. */
const MENTIONS_RETURN: Record<Lang, RegExp> = {
  en: /\brefund\w*|\breturn\w*|\bcomes? back|\bget\w* (?:it )?back|\b(?:paid|given|sent) back/i,
  fr: /\brembours\w*|\brestitu\w*|\brendu\w*|\brevien\w*|\bretourn\w*|\brécup\w*/i,
};

/** Returns the contract never makes: on leaving, in good standing, at a planned close. */
const FORBIDDEN: Record<Lang, Array<[string, RegExp]>> = {
  en: [
    ['a return on leaving', /\bleav(?:e|es|ing)\b|\bquit(?:s|ting)?\b/i],
    ['good standing', /\bgood standing\b/i],
    [
      'a planned close',
      /\bplanned close\b|\bclos(?:e|es|ed|ing)\b|\bwind[- ]?down\b|\bcomplet(?:e|es|ed|ion)\b|\bend of the circle\b/i,
    ],
  ],
  fr: [
    ['a return on leaving', /\bquitt\w*|\bpartir\b|\bdépart\b/i],
    ['good standing', /\ben règle\b|\bbonne (?:foi|conduite)\b/i],
    ['a planned close', /\bclôtur\w*|\bfermeture\b|\btermin\w*|\bfin du cercle\b/i],
  ],
};

/**
 * The three ways, each as a pattern wide enough for the request's own
 * example ("if the organizer removes you before the circle is running, or
 * when the circle is stopped or recovered") and its natural variants. The
 * removal way needs both the actor and the "before it runs" condition.
 * Accented endings carry no trailing \b: JS word boundaries are ASCII-only.
 */
const THREE_WAYS: Record<Lang, Array<[string, RegExp]>> = {
  en: [
    [
      'the organizer removes the member',
      /\b(?:organi[sz]er|admin\w*)\b[^.]*\bremov\w*|\bremov\w*[^.]*\b(?:organi[sz]er|admin\w*)\b/i,
    ],
    [
      '… before the circle is running',
      /\bbefore\b[^.]*\b(?:running|runs|starts?|started|active|activated|live|begins?|begun)\b|\b(?:not|never|isn['’]t|hasn['’]t|has not)\b[^.]*\b(?:running|active|started|begun|live)\b|\binactive\b/i,
    ],
    ['the circle is stopped', /\bstop(?:ped|s)?\b|\bemergency[- ]stop/i],
    ['a recovery refunds everyone', /\brecover(?:y|ed|s|ies)?\b/i],
  ],
  fr: [
    [
      'l’organisateur retire le membre',
      /\b(?:organisat(?:eur|rice)|administrat(?:eur|rice)|admin)\b[^.]*\b(?:retir\w*|exclu\w*|supprim\w*|enl[eè]v\w*)|\b(?:retir\w*|exclu\w*|supprim\w*)[^.]*\b(?:organisat(?:eur|rice)|administrat(?:eur|rice)|admin)\b/i,
    ],
    [
      '… avant que le cercle démarre',
      /\bavant\b[^.]*\b(?:démarr\w*|lanc\w*|activ\w*|actif|en cours|en marche|fonctionn\w*|commenc\w*)|\b(?:pas|jamais)\b[^.]*\b(?:activ\w*|actif|démarr\w*|lanc\w*|en cours)|\binacti(?:f|ve)\b/i,
    ],
    ['le cercle est arrêté', /\barrêt\w*|\bstopp\w*|\binterromp\w*/i],
    ['une récupération rembourse tout le monde', /\brécup\w*|\brecouvr\w*|\bsecours\b|\bsauvetage\b/i],
  ],
};

interface Problems {
  /** Never says the deposit comes back. */
  saysNothingAboutAReturn: boolean;
  /** Promises a return the contract never makes. */
  namesAReturnTheContractNeverMakes: string[];
  /** Of the three ways, the ones the string does not name. */
  waysNotNamed: string[];
}

const CLEAN: Problems = {
  saysNothingAboutAReturn: false,
  namesAReturnTheContractNeverMakes: [],
  waysNotNamed: [],
};

function problems(text: string, lang: Lang): Problems {
  return {
    saysNothingAboutAReturn: !MENTIONS_RETURN[lang].test(text),
    namesAReturnTheContractNeverMakes: FORBIDDEN[lang].filter(([, re]) => re.test(text)).map(([what]) => what),
    waysNotNamed: THREE_WAYS[lang].filter(([, re]) => !re.test(text)).map(([way]) => way),
  };
}

// ---------------------------------------------------------------------------
// Locating each page string by a stable anchor rather than by its own text
// ---------------------------------------------------------------------------

/** create-circle.tsx: the "Security Deposit" bullet of the invite email body. */
function inviteEmailDepositText(): string {
  const lines = read('pages/create-circle.tsx').split('\n');
  const start = lines.findIndex((line) => line.includes('const body = `'));
  expect(start).toBeGreaterThan(-1);
  const region = lines.slice(start, start + 40);
  const at = region.findIndex((line) => /^\s*•\s*Security Deposit/i.test(line));
  expect(at).toBeGreaterThan(-1);
  const bullet = [region[at] ?? ''];
  // A rewrite may wrap onto continuation lines: take them up to the next bullet.
  for (let i = at + 1; i < region.length; i += 1) {
    const line = region[i] ?? '';
    if (line.trim() === '' || /^\s*•/.test(line)) break;
    bullet.push(line);
  }
  return flatten(bullet.join(' '));
}

/** create-circle.tsx: the InfoTooltip under the "Security Deposit" label. */
function securityDepositTooltipText(): string {
  const source = read('pages/create-circle.tsx');
  const anchor = source.indexOf('{/* Security Deposit */}');
  expect(anchor).toBeGreaterThan(-1);
  const open = source.indexOf('<InfoTooltip', anchor);
  expect(open).toBeGreaterThan(-1);
  const close = source.indexOf('</InfoTooltip>', open);
  expect(close).toBeGreaterThan(open);
  return untag(source.slice(open, close));
}

/** contribute/index.tsx: the note under the "Pay Security Deposit" button. */
function payDepositNoteText(): string {
  const source = read('pages/circle/[id]/contribute/index.tsx');
  let anchor = source.indexOf('{/* Add note about payment sequence */}');
  if (anchor === -1) anchor = source.indexOf('must pay the security deposit before');
  expect(anchor).toBeGreaterThan(-1);
  const close = source.indexOf('</p>', anchor);
  expect(close).toBeGreaterThan(anchor);
  const head = source.slice(0, close);
  const open = Math.max(head.lastIndexOf('<p>'), head.lastIndexOf('<p '));
  expect(open).toBeGreaterThan(-1);
  return untag(source.slice(open, close));
}

function dictionaryString(locale: Lang, key: string): string {
  const value: string | undefined = DICTIONARIES[locale][key];
  expect(typeof value).toBe('string');
  return value as string;
}

describe('NJA-2847: deposit wording names the three ways the deposit comes back', () => {
  const strings: Array<[string, Lang, () => string]> = [
    ['create-circle.tsx invite email, "Security Deposit" bullet', 'en', inviteEmailDepositText],
    ['create-circle.tsx "Security Deposit" tooltip', 'en', securityDepositTooltipText],
    ['contribute/index.tsx note under "Pay Security Deposit"', 'en', payDepositNoteText],
    ['i18n en create.depositAuto', 'en', () => dictionaryString('en', 'create.depositAuto')],
    ['i18n en create.depositAutoEmpty', 'en', () => dictionaryString('en', 'create.depositAutoEmpty')],
    ['i18n fr create.depositAuto', 'fr', () => dictionaryString('fr', 'create.depositAuto')],
    ['i18n fr create.depositAutoEmpty', 'fr', () => dictionaryString('fr', 'create.depositAutoEmpty')],
  ];

  it.each(strings)('%s', (_where, lang, locate) => {
    const copy = locate();
    expect(copy.length).toBeGreaterThan(0);
    // `copy` rides along so a failure prints the offending string.
    expect({ copy, ...problems(copy, lang) }).toEqual({ copy, ...CLEAN });
  });

  it('accepts the wording the request allows and rejects the wording it replaces', () => {
    // The rules pass a correct rewrite in both languages …
    expect(
      problems(
        'The deposit comes back only if the organizer removes you before the circle is running, or when the circle is stopped or recovered.',
        'en',
      ),
    ).toEqual(CLEAN);
    expect(
      problems(
        'Le dépôt revient seulement si l’organisateur vous retire avant que le cercle démarre, ou lorsque le cercle est arrêté ou récupéré.',
        'fr',
      ),
    ).toEqual(CLEAN);
    // … and are not satisfied by the strings this ticket replaces.
    const replaced: Array<[string, Lang]> = [
      ['(one-time, refundable)', 'en'],
      ['Refundable when leaving the circle in good standing', 'en'],
      ['The deposit is refundable if you decide to leave the circle later.', 'en'],
      ['Each member also puts down a refundable security deposit, half of one contribution. Adjust it under More settings.', 'en'],
      ['Chaque membre verse aussi un dépôt de garantie remboursable, soit la moitié d’un versement. Ajustez-le sous Plus de réglages.', 'fr'],
    ];
    for (const [text, lang] of replaced) {
      expect(problems(text, lang)).not.toEqual(CLEAN);
    }
  });
});
