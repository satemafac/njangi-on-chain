/**
 * Source guards for copy that asserts something the contract does not enforce.
 *
 * The manage page told every admin that activating a circle "requires ... a
 * non-admin recovery delegate". `activate_circle`
 * (move/sources/njangi_circles.move:635) enforces that only inside
 * `if (config::is_auto_release_enabled(&circle.id))`. On a circle created
 * without auto-release the demand was not merely premature — it was
 * unsatisfiable: the contract stores `option::none()` for the delegate at
 * creation (njangi_circles.move:555) and exposes no entry point to change it,
 * while the UI disabled the very button it was telling the admin to press.
 *
 * These are source-text assertions rather than render tests because jest runs
 * `testEnvironment: 'node'` with `testMatch: ['**\/__tests__\/**\/*.test.ts']` —
 * no jsdom, no testing-library, and `.tsx` is not matched. The same technique
 * as scripts/check-marketing-copy.mjs, which is what caught the yield
 * vocabulary. A guard that can actually run beats a render test that cannot.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { DICTIONARIES } from '@/lib/i18n';

const read = (rel: string) =>
  readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

/** Comments explain the rule; they must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('activation requirement copy', () => {
  it('the escrow panel does not enumerate activation requirements', () => {
    // The panel has no recoveryStatus prop and cannot know whether a delegate
    // is required, so it must point at the manage page rather than guess.
    // Only the manage page passes showAdminOpenButton, so this branch is the
    // admin view exclusively.
    const panel = stripComments(read('components/CycleEscrowPanel.tsx'));

    expect(panel).not.toMatch(/delegate/i);
    expect(panel).not.toMatch(/recovery delegate/i);
  });

  it('delegate copy lives in the pure helper, not inline in the page', () => {
    // Inline ternaries are how the enabled/disabled distinction got lost in
    // five places at once. getRecoveryDelegateCardCopy owns the wording and is
    // unit-tested for the disabled and unknown cases.
    const page = stripComments(read('pages/circle/[id]/manage/index.tsx'));

    expect(page).not.toContain('Delegate required');
    expect(page).not.toContain('Set a valid delegate before activating this circle');
    expect(page).not.toContain(
      'Auto-release now requires a valid delegate address before this fallback should be relied on.',
    );
    expect(page).toContain('getRecoveryDelegateCardCopy');
  });

  it('the delegate validator is not hardcoded as always-required', () => {
    // required:true ignored autoReleaseEnabled. Latent only because the edit
    // button happened to be disabled on those circles — same bug class.
    const page = stripComments(read('pages/circle/[id]/manage/index.tsx'));

    expect(page).not.toMatch(/getRecoveryDelegateValidationError\(\{[^}]*required:\s*true/);
  });
});

describe('mid-cycle migration copy', () => {
  // The declared history is a claim about turns taken somewhere Njangi cannot
  // see. The members confirm it; the software does not check it. Copy that
  // says "verified" turns a group's own bookkeeping into a platform assurance
  // we have no basis for — the same over-claim class as the regulatory and
  // fraud-elimination patterns already banned in check-marketing-copy.mjs.
  const surfaces = [
    'components/CircleMigrationPanel.tsx',
    'pages/circle/[id]/contribute/index.tsx',
    'pages/create-circle.tsx',
  ];

  it.each(surfaces)('%s does not claim the recorded history is verified', (rel) => {
    const source = stripComments(read(rel));

    expect(source).not.toMatch(/verif\w*\s+(?:history|payouts?|turns?|rotation)/i);
    expect(source).not.toMatch(/(?:history|turns?|payouts?)\s+(?:are|is|was|were)\s+verif/i);
  });

  it.each(surfaces)('%s attributes the history to the members, not the platform', (rel) => {
    const source = stripComments(read(rel));

    // "we confirmed" / "Njangi confirms" would put the assurance on us.
    expect(source).not.toMatch(/\b(?:we|njangi)\s+(?:confirm|verify|validate)\w*\b/i);
  });

  // The standalone confirm button exists precisely for members whose deposit
  // is already paid (no deposit transaction left to ride along with). It once
  // lived inside renderContributionOptions, which returns null when
  // userDepositPaid — unreachable for exactly its audience, deadlocking
  // activation. It must render at page level, outside that helper.
  it('the confirm panel is not gated behind the deposit-only payment card', () => {
    const page = stripComments(read('pages/circle/[id]/contribute/index.tsx'));

    expect(page).toContain('{renderMigrationConfirmation()}');

    // Nothing after renderContributionOptions begins may depend on the
    // confirmation flag: the helper early-returns on userDepositPaid, so any
    // migration UI inside it is dead for paid-up members.
    const helperStart = page.indexOf('const renderContributionOptions');
    expect(helperStart).toBeGreaterThan(-1);
    expect(page.slice(helperStart)).not.toContain('needsMyMigrationConfirmation');
  });

  // Every member must sign off before a declared history takes effect
  // (EMigrationNotRatified, njangi_circles.move). If the manage page ever
  // stopped gating on that, the button would promise an activation the
  // contract refuses.
  it('the manage page gates activation on unanimous confirmation', () => {
    const page = stripComments(read('pages/circle/[id]/manage/index.tsx'));

    expect(page).toContain('migrationRatification');
    expect(page).toMatch(/migrationSettled/);
  });

  // The version the member saw is what makes a rewritten ledger abort rather
  // than silently inherit their agreement. Re-reading it at signing time would
  // defeat the guard entirely.
  it('the contribute page confirms against the version on screen', () => {
    const page = stripComments(read('pages/circle/[id]/contribute/index.tsx'));

    expect(page).toContain('migrationVersionOnScreen');
    expect(page).toContain('acknowledgeMigrationVersion: migrationVersionOnScreen');
  });
});

describe('WhatsApp Premium copy', () => {
  // What a WhatsApp link delivers today: content/whatsapp-updates.ts lists it,
  // and docs/whatsapp-integration-setup.md ("What gets sent") explains it.
  // Circle updates go to the ONE number the circle admin linked
  // (resolveCirclePhone, lib/whatsapp-bot/circle-phone.ts), and only the admin
  // can link a number: whatsapp_integration::link_circle aborts with
  // E_NOT_CIRCLE_ADMIN otherwise. The "your turn" nudge goes to a number the
  // round's recipient linked as an admin (resolveMemberPhone in
  // lib/whatsapp-notifier.ts matches linked_by). Nothing sends reminders, and
  // the contribution and payout streams wait on the escrow-event relay.
  //
  // The pricing card sold "turn and payout notifications" and the upsell said
  // "members get turn reminders and payout alerts": a paid promise of messages
  // members never received.
  const KEYS = [
    'pricing.premium.feature.whatsapp',
    'billing.whatsappSuite.title',
    'billing.whatsappSuite.body',
  ];

  // Each pattern is a promise the channel does not keep. EN and FR share one
  // list, so a locale that borrows the other's wording is caught too.
  const UNSENT: ReadonlyArray<readonly [RegExp, string]> = [
    [/remind|rappel|deadline|échéance/i, 'nothing sends reminders'],
    [/\bmembers?\b|\bmembres?\b/i, 'members are not messaged: only the circle admin can link a number'],
    [/\bturns?\b|\btours?\b/i, '"your turn" reaches only a recipient who linked a number as an admin'],
    [
      // "the payout order" / "l'ordre des versements" name an update that is
      // sent (RotationOrderChanged), not a payout notice.
      /\bpayouts?\b(?!\s+order)|\bcontributions?\b|\bpaiements?\b|\bcotisations?\b|\bversements?\b(?<!ordre des versements)/i,
      'contribution and payout updates are not sent yet',
    ],
  ];

  const unsentPromises = (text: string): string[] =>
    UNSENT.filter(([pattern]) => pattern.test(text)).map(([, why]) => why);

  const copy: Array<[string, string, string]> = Object.entries(DICTIONARIES).flatMap(
    ([locale, dict]) =>
      KEYS.filter((key) => key in dict).map((key): [string, string, string] => [
        locale,
        key,
        dict[key],
      ]),
  );

  it('the keys exist in EN and FR, so the checks below are not vacuous', () => {
    const missing = KEYS.filter((key) => !(key in DICTIONARIES.en) || !(key in DICTIONARIES.fr));
    expect(missing).toEqual([]);
  });

  it.each(copy)('%s %s promises only what is sent', (_locale, _key, text) => {
    expect(unsentPromises(text)).toEqual([]);
  });

  it("the server's upgrade message promises only what is sent", () => {
    // BillingUpsellModal shows the 402 body's message ahead of the localized
    // body, so on the WhatsApp card this is the sentence the admin reads.
    const gate = stripComments(read('lib/entitlement-gate.ts'));
    const message = gate.match(/case 'whatsappSuite':\s*return '([^']+)'/)?.[1];

    expect(message).toBeDefined();
    expect(unsentPromises(message ?? '')).toEqual([]);
  });

  it('rejects the copy it replaced', () => {
    const replaced = [
      'WhatsApp linking + turn and payout notifications',
      'Link your circle to WhatsApp so members get turn reminders and payout alerts right where they already chat.',
      'Liaison WhatsApp + notifications de tour et de paiement',
      'Reliez votre cercle à WhatsApp pour que les membres reçoivent les rappels de tour et les alertes de paiement là où ils discutent déjà.',
    ];

    for (const text of replaced) {
      expect(unsentPromises(text)).not.toEqual([]);
    }
  });
});
