// i18n.ts — Lightweight runtime translation helper for njangi copy.
//
// This is intentionally tiny: no i18next dependency, no context provider,
// no async loader. The Phase 6 target is the Cameroon / CEMAC corridor,
// where the usable audience is split roughly 50/50 between English and
// French speakers. Pidgin support is a straight bolt-on when we have
// native speakers to validate the tone.
//
// Callers:
//   import { t, setLocale } from '@/lib/i18n';
//   t('escrow.payShare', { amount: '50 SUI' })  // "Pay my share — 50 SUI"
//
// Locale selection rules (first match wins):
//   1. localStorage.getItem('njangi.locale')
//   2. navigator.language prefix (en, fr)
//   3. 'en' fallback

// `pcm` = Nigerian / Cameroonian Pidgin (ISO 639-3), the lingua franca
// across much of the Njangi diaspora. `sw` = Kiswahili for the East
// African corridor. Both dictionaries reuse the same placeholder syntax
// as the EN / FR ones; new locales only need to add a sibling entry to
// DICTIONARIES and SUPPORTED_LOCALE_OPTIONS.
export type Locale = 'en' | 'fr' | 'pcm' | 'sw' | 'am' | 'ar' | 'fa';

const SUPPORTED_LOCALES: Locale[] = ['en', 'fr', 'pcm', 'sw', 'am', 'ar', 'fa'];

// Arabic + Farsi are RTL. LocaleDirSync flips `html dir` based on this
// set, and the scaffold we added in Phase 9 means the rest of the app
// (which already uses flex/grid layouts) picks up the direction change
// without further work.
const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ar', 'fa']);

export function getLocaleDirection(locale: Locale): 'ltr' | 'rtl' {
  return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}
const STORAGE_KEY = 'njangi.locale';

type StringDict = Record<string, string>;

// Exported for the key-parity test (src/lib/__tests__/i18n-key-parity.test.ts)
// so it can assert every FR key has an EN counterpart and vice versa. Not
// part of the public translation API — callers should use `t()` / `setLocale`.
export const DICTIONARIES: Record<Locale, StringDict> = {
  en: {
    // Escrow panel
    'escrow.sectionTitle': "This round's pot",
    'escrow.header.withCircle': '{circle} · round {cycle}',
    'escrow.header.noCircle': 'Round {cycle}',
    'escrow.headerBlurb':
      'Everyone pays the same share into the pot. When the pot is full, the next member on the rotation list takes the payout.',
    'escrow.refresh': 'Refresh status',
    'escrow.refreshing': 'Checking…',
    'escrow.signInHint':
      'Please sign in again to pay into the pot or collect a payout. Your wallet session needs to be active so your phone can sign the transaction — nothing is ever sent to our server.',
    'escrow.loading': "Looking up this round's pot on the blockchain…",
    'escrow.loadFailed':
      "We couldn't reach the network to check this round. It may already be open — retry in a moment.",
    'escrow.notOpen':
      "This round hasn't been opened yet. Once the circle admin opens it, members can pay their share and the first person on the list will be ready to collect.",
    'escrow.openRound': 'Open this round',
    'escrow.openingRound': 'Opening round…',
    'escrow.confirmingRound': 'Confirming the round opened…',
    'escrow.confirmingRoundNotice':
      'Your transaction to open this round went through. Waiting for the network to show the new pot — opening stays off until it does, so the round cannot be opened twice.',
    'escrow.confirmTimedOut':
      "We still can't see the new pot. Refresh and check that the round isn't already open before opening it again.",
    'escrow.roundAlreadyOpen':
      'A pot for this round is already open on the blockchain. Refreshing so you can see it.',
    'escrow.refunded':
      'Round {cycle} was cancelled and every contribution went back to the member who paid it. The circle admin can open this round again.',
    'escrow.reopenRound': 'Open this round again',
    'escrow.onlyAdminOpens': 'Only the circle admin can open the round.',
    'escrow.yourShare': 'Your share this round',
    'escrow.whoseTurn': 'Whose turn it is',
    'escrow.yourTurn': "That's you — your payout is waiting.",
    'escrow.paymentsReceived': 'Payments received',
    'escrow.progressLabel': '{paid} of {required} members have paid in for this round',
    'escrow.ringCaption': 'Current round contributions',
    'escrow.status.receiving': 'Receiving payout',
    'escrow.status.paid': 'Contributed',
    'escrow.status.pending': 'Pending',
    'escrow.alreadyPaid': "✓ You've paid your share for this round. Waiting on the other members.",
    'escrow.prompt.payYourShare': 'Pay your share and the pot moves one step closer to full.',
    'escrow.action.payShare': 'Pay my share — {amount}',
    'escrow.action.paying': 'Paying…',
    'escrow.prompt.collectPayout':
      "Everyone has paid. It's your turn — tap below to send the pot straight to your wallet.",
    'escrow.action.collect': 'Collect my payout',
    'escrow.action.collecting': 'Collecting…',
    'escrow.prompt.someoneElseCollects':
      'The pot is full. {recipient} can collect their payout now.',
    'escrow.completed':
      '✓ Round {cycle} complete. {recipient} has collected the payout. The circle admin can open the next round whenever everyone is ready.',
    'escrow.lastTx': 'Last transaction: {digest}',
    // Toasts
    'toast.roundOpened': 'This round is now open — members can pay their share.',
    'toast.sharePaid': 'Thanks! Your share is in the pot.',
    'toast.payoutSent': 'Your payout is on its way to your wallet.',
    'toast.signInAgain': 'Please sign in again to continue.',
    'toast.genericError': 'Something went wrong: {error}',
    // Dashboard alerts
    'alerts.yourShareDue.title': 'You have a share to pay',
    'alerts.yourShareDue.body':
      'The {circle} circle is waiting on your share — {amount}. Tap to pay into the pot.',
    'alerts.yourTurn.title': "It's your turn to collect",
    'alerts.unreadable':
      "We couldn't check {count} of your circles just now, so anything due there isn't shown. Please refresh in a moment.",
    'alerts.yourTurn.body':
      'Everyone in {circle} has paid. Your payout of {amount} is ready — tap to send it to your wallet.',
    'alerts.adminOpenRound.title': 'Ready to start the next round?',
    'alerts.adminOpenRound.body':
      'The previous round finished. Open round {cycle} in {circle} so members can start paying.',
    // Shared navigation / chrome
    'nav.learn': 'Learn',
    'nav.faq': 'FAQ',
    'nav.mainnetUpdates': 'Mainnet updates',
    'nav.login': 'Log in',
    'nav.openDashboard': 'Open dashboard',
    'nav.testnet': 'Testnet',
    'nav.mainnet': 'Mainnet',
    'nav.viewing': 'Viewing {network}',
    'nav.freePlan': 'Free plan',
    'nav.premium': 'Premium',
    'nav.signOut': 'Sign Out',
    'nav.notifications': 'Notifications',
    // Landing page
    'landing.eyebrow': 'Rotating savings circles — for the global diaspora',
    'landing.heroTitle':
      'The savings circle your family already trusts — now with rules nobody can quietly break.',
    'landing.heroSubtitle':
      "Members contribute on schedule, each takes the pot in turn. Njangi On-Chain keeps that exact rhythm and makes every contribution and payout self-custodied, scheduled, and verifiable — no treasurer holding the cash, no seed phrase to start.",
    'landing.heroCardTitle': 'Start with a familiar identity',
    'landing.heroCardBody':
      'Sign in with a social account. Wallet creation happens in the background so members can start with less operational friction.',
    'landing.noSeedPhrase': 'No seed phrase required to begin',
    'landing.builtForCircles': 'Built for member-run circles, not generic accounts',
    'landing.exploreHowItWorks': 'Explore how it works',
    'landing.joinReleaseList': 'Join the mainnet release list',
    'landing.proof.liveCircles': 'Live circles',
    'landing.proof.supportedAssets': 'Supported assets',
    'landing.proof.currentEnvironment': 'Current environment',
    'landing.proof.syncing': 'Syncing',
    'landing.proof.custodyLabel': 'Custody',
    'landing.proof.custodyValue': 'Self-held',
    'landing.heritageAlso':
      'Also known as njangi, esusu, stokvel, tontine and many other names.',
    'landing.signInTitle': 'Sign in with a familiar account',
    'landing.signInBody':
      'Use Google, Facebook, or Apple with zkLogin. Wallet creation happens in the background so you can enter the app without a separate crypto onboarding step.',
    'landing.networkSwitchTitle': 'Switch to {network}?',
    'landing.networkSwitchBody':
      'Network environments use different wallet addresses. Switching clears the active zkLogin session so balances, circles, and history stay aligned to the environment you selected.',
    'landing.networkSwitchStay': 'Stay here',
    'landing.networkSwitchConfirm': 'Switch to {network}',
    'landing.features.eyebrow': "Why it's built this way",
    'landing.features.title':
      "Tradition's trust, with infrastructure's clarity.",
    'landing.features.body':
      'The goal is not to make a savings circle feel like a trading product. The goal is to make it easier for members to know what is happening, when it is happening, and where funds are moving.',
    'landing.feature.sharedVisibility.title': 'Everyone sees the same ledger',
    'landing.feature.sharedVisibility.body':
      "Contributions, payout order, and who's next are visible to the whole circle — not living in one person's chat history or notebook.",
    'landing.feature.selfCustody.title': 'No one holds the pot but the chain',
    'landing.feature.selfCustody.body':
      "Members contribute from and get paid to their own wallets. Njangi never holds a balance, so there's no treasurer to chase and nothing for us to lose.",
    'landing.feature.borderless.title': 'One circle across many countries',
    'landing.feature.borderless.body':
      'Diaspora groups stay in sync without depending on a single bank, currency, or time zone. Save together from anywhere.',
    'landing.feature.culturalContinuity.title': 'The same circle, less friction',
    'landing.feature.culturalContinuity.body':
      "The trust and rhythm of your njangi stay exactly as they are. We only remove the spreadsheets, reminders, and did-you-pay-yet messages.",
    'landing.workflow.eyebrow': 'How a cycle works',
    'landing.workflow.title': 'Three moves, one clear rhythm.',
    'landing.workflow.body':
      'Njangi On-Chain is built for communities that already know how to save together. It adds clearer structure, not a new social model.',
    'landing.workflow.step1.title': 'Sign in, no wallet setup',
    'landing.workflow.step1.body':
      'Use Google, Apple, or Facebook. Your on-chain wallet is created in the background — no seed phrase, no app to install.',
    'landing.workflow.step2.title': 'Set the rules once, together',
    'landing.workflow.step2.body':
      "Agree on members, amounts, schedule, and payout order up front. Everyone sees the same terms, so there's nothing to renegotiate later.",
    'landing.workflow.step3.title': 'Contribute and get paid, on schedule',
    'landing.workflow.step3.body':
      "Each turn pays out automatically to the next member's own wallet. Track who's contributed and who's next — no follow-up texts required.",
    'landing.launch.eyebrow': 'Mainnet release',
    'landing.launch.title': 'Follow the launch without following noise.',
    'landing.launch.body':
      'The product is live for testnet exploration today. Join the release list if you want the clearest signal on production readiness, rollout timing, and early access.',
    'landing.launch.emailPlaceholder': 'Enter your email address',
    'landing.launch.notifyButton': 'Notify me about mainnet',
    'landing.launch.signingUp': 'Signing up...',
    'landing.launch.disclaimer':
      'Updates are limited to meaningful milestones. No weekly filler, no broadcast spam.',
    'landing.faq.eyebrow': 'Common questions',
    'landing.faq.title': 'A few things people ask first.',
    'landing.faq.body':
      'If you want the full context, the deeper guides live in the learning and FAQ sections. These cover the basics.',
    'landing.faq.learnLink': 'Learn about savings circles',
    'landing.faq.fullFaqLink': 'View the full FAQ',
    'landing.heroPrimaryCta': 'Start a circle',
    'landing.heroCtaReassure':
      'Takes about 30 seconds — sign in with Google, Apple, or Facebook. No wallet to set up.',
    'landing.testnetNote':
      'Live on testnet today — explore the full flow with test funds, no real money at risk.',
    'landing.faq.q1': 'What is a Njangi?',
    'landing.faq.a1':
      'A Njangi is a rotating community savings structure where members contribute on a shared schedule and each member receives the pooled amount in turn. Similar systems exist globally under many different names.',
    'landing.faq.q2': 'Why put a savings circle on-chain?',
    'landing.faq.a2':
      'The point is not novelty. The point is clarity. On-chain records make contributions, payout order, and settlement easier to verify, especially when members are distributed across cities or countries.',
    'landing.faq.q3': 'Do members need deep crypto experience?',
    'landing.faq.a3':
      'No. zkLogin lowers the onboarding burden by letting members start with a familiar social account while still receiving a wallet tied to the selected network.',
    'landing.faq.q4': 'What happens when I switch between testnet and mainnet?',
    'landing.faq.a4':
      'Your wallet address changes because each network has its own state. The app clears the current session so the selected environment stays clean and consistent.',
    'landing.tradition.eyebrow': 'A global tradition',
    'landing.tradition.title': 'One tradition, twenty-five names.',
    'landing.tradition.body':
      'Communities across the world already understand rotating savings. Njangi On-Chain is designed to respect that history rather than flatten it into a generic fintech pattern.',
    'landing.footer.tagline':
      'Built on Sui with zkLogin for low-friction community access.',
    'landing.footer.rights': '© {year} Njangi On-Chain. All rights reserved.',
    // Auth page
    'auth.title': 'Account Authentication',
    'auth.whatsappTitle': 'WhatsApp Authentication',
    'auth.checking': 'Checking authentication status...',
    'auth.pleaseAuthenticate': 'Please authenticate your account',
    'auth.pleaseAuthenticateWhatsapp':
      'Please authenticate your account for WhatsApp ({phone})',
    'auth.alreadyAuthenticated': 'You are already authenticated!',
    'auth.successTitle': 'Authentication Successful!',
    'auth.redirecting': 'Authentication successful! Redirecting...',
    'auth.chooseMethod': 'Choose your preferred login method:',
    'auth.goToDashboard': 'Go to Dashboard',
    'auth.closePage': 'Close Page',
    'auth.poweredByZkLogin': 'Secure authentication powered by zkLogin',
    // Create circle
    'create.eyebrow': 'Create circle',
    'create.stepCounter': 'Step {current} of {total}',
    'create.step.type.label': 'Circle type',
    'create.step.type.title': 'Choose the circle structure',
    'create.step.type.description':
      'Start with the operating model. Rotational circles take turns receiving the pot; smart-goal circles (Premium) save toward shared milestones.',
    'create.step.currency.label': 'Currency',
    'create.step.currency.title': 'Choose the value anchor',
    'create.step.currency.description':
      'Set the currency your members understand and plan around. SUI remains the settlement rail underneath.',
    'create.step.config.label': 'Configuration',
    'create.step.config.title': 'Define how the circle runs',
    'create.step.config.description':
      'Set the name, contribution amount, cadence, deposit, and optional rules that will guide this group.',
    'create.step.invites.label': 'Invites',
    'create.step.invites.title': 'Invite members into the circle',
    'create.step.invites.description':
      'Share the link, prepare email invites, and hand the circle off to the people who will run it with you.',
    'create.circleNameLabel': 'Group Name',
    'create.circleNamePlaceholder': "Enter your circle's name",
    'create.cancel': 'Cancel',
    'create.nextInvite': 'Next: Invite Members',
    'create.backToDashboard': 'Back to dashboard',
    // Join / discovery
    'join.eyebrow': 'Join circle',
    'join.reviewTerms':
      'Review the contribution terms, send a join request, and wait for approval from the circle admin before you participate.',
    'join.members': '{current} of {max} members',
    'join.requestsOpen': 'Requests open',
    'join.requestsPaused': 'Requests paused',
    'join.contribution': 'Contribution',
    'join.securityDeposit': 'Security deposit',
    'join.circleAdmin': 'Circle admin',
    'join.requestToJoin': 'Request to join circle',
    'join.submitting': 'Submitting request...',
    'join.alreadyMember': 'Already a member',
    'join.signInToRequest': 'Sign in to request access',
    'join.signInBody':
      'Use your preferred provider to continue. The app will return you to this circle after login.',
    'join.backToDashboard': 'Back to dashboard',
    'join.backToHome': 'Back to home',
    // Contribute page chrome
    'contribute.backToDashboard': 'Back to Dashboard',
    'contribute.eyebrow': 'Circle Payment',
    'contribute.title': 'Contribute',
    'contribute.workspaceEyebrow': 'Contribution Workspace',
    'contribute.headingWithCircle': 'Contribute to {circle}',
    'contribute.heading': 'Contribute to Circle',
    'contribute.blurb':
      'Review wallet readiness, circle requirements, and the current cycle state before submitting your payment.',
    // Dashboard chrome
    'dashboard.eyebrow': 'Njangi On-Chain Dashboard',
    'dashboard.welcome': 'Welcome back{name}.',
    'dashboard.blurb':
      'Keep your circles, contributions, and cash movement organized in one quiet workspace.',
    'dashboard.refreshCircles': 'Refresh circles',
    'dashboard.joinCircle': 'Join circle',
    'dashboard.newCircle': 'New circle',
    'dashboard.emptyTitle': 'No circles yet',
    'dashboard.emptyBody': 'Start by creating a circle or joining one with an invite link.',
    'dashboard.emptyJoin': 'Join a circle',
    'dashboard.emptyCreate': 'Create a circle',
    'dashboard.loadMore': 'Load more circles',
    'dashboard.loadingMore': 'Loading circles...',
    'dashboard.roleAdmin': 'Admin',
    'dashboard.roleMember': 'Member',
    // Pricing page
    'pricing.eyebrow': 'Pricing',
    'pricing.title': 'Simple pricing that never touches your savings',
    'pricing.subtitle':
      'Run a circle for free, forever. Premium adds coordination conveniences for larger groups — your contributions, payouts, and recovery stay self-custodied and free on every plan.',
    'pricing.comingSoonBanner': 'Premium is launching soon — every plan keeps your funds self-custodied and free.',
    'pricing.breadcrumbHome': 'Home',
    'pricing.breadcrumbPricing': 'Pricing',
    'pricing.free': 'Free',
    'pricing.alwaysFreeBadge': 'Always free',
    'pricing.forever': 'forever',
    'pricing.freeBlurb':
      'Everything a small circle needs to save together with on-chain clarity.',
    'pricing.premium': 'Premium',
    'pricing.comingSoon': 'Launching soon',
    'pricing.yourPlan': 'Your plan',
    'pricing.forOrganizers': 'For organizers',
    'pricing.perMonth': 'per month',
    'pricing.premiumBlurb':
      'For admins coordinating bigger groups — more members, more circles, and updates where your members already chat.',
    'pricing.billedMonthly':
      'Billed monthly through Stripe. Cancel anytime — your circles and funds are unaffected when a subscription ends.',
    'pricing.ctaComingSoon': 'Launching soon',
    'pricing.ctaSignInToUpgrade': 'Sign in to upgrade',
    'pricing.ctaManageSubscription': 'Manage subscription',
    'pricing.ctaOpeningPortal': 'Opening portal…',
    'pricing.ctaUpgrade': 'Upgrade to Premium',
    'pricing.ctaStartingCheckout': 'Starting checkout…',
    'pricing.ctaGoToDashboard': 'Go to your dashboard',
    'pricing.ctaGetStarted': 'Get started free',
    'pricing.cancelledNotice':
      'Checkout was cancelled — nothing was charged. You can upgrade whenever you’re ready.',
    'pricing.assuranceTitle': 'Your money is never behind a paywall',
    'pricing.assuranceBody':
      'Njangi On-Chain is non-custodial: contributions sit in per-circle escrow on Sui, payouts go straight to members’ own wallets, and recovery is member-initiated. Contributing, collecting a payout, recovering access, and withdrawing funds work the same on the Free and Premium plans — a subscription only adds coordination conveniences, never access to your savings.',
    'pricing.faqTitle': 'Common questions',
    'pricing.faq.whoPays.q': 'Who pays for Premium?',
    'pricing.faq.whoPays.a':
      'The circle admin. One subscription covers every circle they run — members never need to pay anything.',
    'pricing.faq.cancel.q': 'What happens if I cancel?',
    'pricing.faq.cancel.a':
      'Your circles keep running and every member keeps full access to their funds. You simply return to the Free plan limits for new circles and features.',
    'pricing.faq.fees.q': 'Are there other fees?',
    'pricing.faq.fees.a':
      'Only standard Sui network fees (typically a few cents), paid to the blockchain — not to us. On Premium, we cover those network fees for your members’ contributions and claims (fair use), so they never need to hold crypto for gas. On the Free plan members simply pay their own small network fee.',
    'pricing.faq.gasFree.q': 'What is “gas-free for members”?',
    'pricing.faq.gasFree.a':
      'Every Sui transaction needs a tiny network fee (“gas”), normally paid in SUI. When you subscribe to Premium, your subscription covers that fee for your members’ contributions and claims — so someone can join and pay into your circle with only USDC, without first buying SUI for gas. Fair-use limits apply to prevent abuse; the money flow itself is never blocked.',
    'pricing.footerDisclaimer':
      'Premium covers coordination features only. It is not financial advice, custody, or a guarantee of returns. Cryptocurrency use carries risk — check the rules that apply in your country.',
    'pricing.free.feature.circles': '{count} savings circle',
    'pricing.free.feature.members': 'Up to {count} members per circle',
    'pricing.free.feature.escrow': 'Core escrow rounds — contribute and collect on rotation',
    'pricing.free.feature.recovery': 'Member-initiated recovery, always included',
    'pricing.free.feature.zklogin': 'zkLogin sign-in with self-custodied wallets',
    'pricing.premium.feature.members': 'Up to {count} members per circle',
    'pricing.premium.feature.circles': 'Run up to {count} circles at once',
    'pricing.premium.feature.whatsapp': 'WhatsApp linking + turn and payout notifications',
    'pricing.premium.feature.goals': 'Smart savings goals for your circles',
    'pricing.premium.feature.gasFree': 'Gas-free contributions for all your members (fair use)',
    'pricing.premium.feature.analytics': 'Circle analytics and contribution insights',
    'pricing.premium.feature.everything': 'Everything in Free',
    'pricing.alwaysFreeNoteLabel': 'Always free, on every plan:',
    'pricing.alwaysFreeNoteBody':
      'collecting your payout, member-initiated recovery, and withdrawing your funds never require a subscription.',
    // Billing upsell modal
    'billing.notNow': 'Not now',
    'billing.seePlans': 'See plans',
    'billing.alwaysFreeNote':
      'Collecting payouts, recovery, and withdrawing your funds are always free — Premium only adds coordination conveniences.',
    'billing.generic.title': 'This is a Premium feature',
    'billing.generic.body': 'Upgrade to Premium to unlock it for your circles.',
    'billing.whatsappSuite.title': 'WhatsApp updates are a Premium feature',
    'billing.whatsappSuite.body':
      'Link your circle to WhatsApp so members get turn reminders and payout alerts right where they already chat.',
    'billing.maxMembers.title': 'Bigger circles are a Premium feature',
    'billing.maxMembers.body':
      'Free circles hold a few close members. Premium grows a circle to the full rotation the contract supports.',
    'billing.maxCircles.title': 'More circles are a Premium feature',
    'billing.maxCircles.body':
      'The Free plan covers one circle. Premium lets you organize several circles side by side.',
    'billing.smartGoals.title': 'Smart goals are a Premium feature',
    'billing.smartGoals.body':
      'Set savings targets and milestones for your circle and watch progress build every round.',
    'billing.analytics.title': 'Analytics are a Premium feature',
    'billing.analytics.body':
      'See contribution history, on-time rates, and payout trends across your circles.',

    // Address-drift interstitial (src/components/AddressDriftModal.tsx).
    // Frightening moment, our fault, plain words: no "salt", no blame, no
    // promises of recovery we cannot deliver.
    'drift.title': 'This sign-in opened a different account',
    'drift.intro':
      'Signing in just now gave you a different account than the one you used before. This is a problem on our side, not something you did.',
    'drift.previousLabel': 'Your previous account',
    'drift.currentLabel': 'The account you are in now',
    'drift.whatNow':
      'Anything you saved before — your circles and your money — is still at the previous account. It has not been lost or moved. But this sign-in cannot reach it, and we cannot move funds between accounts for you.',
    'drift.reassure': 'We have been alerted automatically and are looking into it.',
    'drift.canStill':
      'You can still collect a payout that is owed to you, ask for a refund, and take part in your circle’s recovery vote.',
    'drift.cannotYet':
      'Joining a circle, creating one, and paying a contribution are paused until this is sorted out.',
    'drift.support': 'Please contact support and mention both accounts shown above.',
    'drift.languageLabel': 'Language',
    'drift.dismiss': 'I understand',

    // Circle Record (src/components/CircleRecordView.tsx, /record pages).
    // Compliance boundary: facts only — no score/rating/grade vocabulary,
    // and never a negative claim about a person.
    'record.eyebrow': 'Savings circle record',
    'record.title': 'Participation record',
    'record.generated': 'Generated {date} · {network}',
    'record.sharedNote': 'Shared with you by the person this record belongs to.',
    'record.summary.circlesJoined': 'Circles joined',
    'record.summary.payoutsReceived': 'Payouts received',
    'record.summary.completedRounds': 'Completed rounds',
    'record.summary.memberSince': 'Member since',
    'record.fullFundingNote':
      'A round only completes when every member has paid in full — the circle cannot move to the next person otherwise. Each completed round below is therefore a round that was fully funded.',
    'record.circles.heading': 'Circles',
    'record.circles.empty':
      'No circles yet. Once you join one, your record starts building here.',
    'record.circle.untitled': 'Untitled circle',
    'record.circle.joined': 'Joined {date}',
    'record.circle.completedRounds': 'Completed rounds',
    'record.circle.members': 'Members',
    'record.circle.yourTurn': 'Your turn',
    'record.circle.turnNotSet': 'Not set',
    'record.circle.payout': 'Payout',
    'record.circle.payoutReceived': 'Received (round {round})',
    'record.circle.payoutNotYet': 'Turn not yet reached',
    'record.circle.onTime': 'On time',
    'record.circle.onTimeValue': '{onTime} of {recorded} recorded',
    'record.verify.title': 'How to check this.',
    'record.verify.body':
      'Every figure above comes from public records on the Sui network. Open any circle link to read the same information directly, without relying on this page.',
    'record.disclaimer':
      'This is a record of savings circle activity. It is not a credit report, not a score, and not an assessment of anyone’s creditworthiness. It shows what happened; it does not rate the person it belongs to.',
    'record.page.loading': 'Reading your record…',
    'record.page.loadFailed':
      'We couldn’t read your record just now. Nothing is wrong with your circles — this is a problem reading the public records.',
    'record.page.retry': 'Try again',
    'record.page.signedOutTitle': 'Your record',
    'record.page.signedOutBody': 'Sign in to see your savings circle record.',
    'record.page.signedOutCta': 'Go to sign in',
    'record.share.heading': 'Share or save',
    'record.share.blurb':
      'A share link lets someone read this record without an account. It stops working on its own after the time you choose, and you can turn it off at any moment.',
    'record.share.lasts': 'Link lasts',
    'record.share.days': '{n} days',
    'record.share.create': 'Create link',
    'record.share.print': 'Print',
    'record.share.download': 'Download',
    'record.share.until': 'until {date}',
    'record.share.revoke': 'Turn off',
    'record.share.created': 'Link created',
    'record.share.createdCopied': 'Link created and copied',
    'record.share.createFailed': 'Could not create the link. Please try again.',
    'record.share.revoked': 'Link turned off',
    'record.share.revokeFailed': 'Could not turn off that link.',
    'record.shared.missingTitle': 'This link isn’t available',
    'record.shared.missingBody':
      'It may have expired or been turned off by the person who shared it. Ask them for a new link.',
    'record.shared.loadFailed': 'We couldn’t load this record just now. Please try again shortly.',
    'record.dashboard.title': 'Your record',
    'record.dashboard.blurb': 'Your circle history — view, print, or share it',
  },
  fr: {
    // Escrow panel
    'escrow.sectionTitle': 'La cagnotte de ce tour',
    'escrow.header.withCircle': '{circle} · tour {cycle}',
    'escrow.header.noCircle': 'Tour {cycle}',
    'escrow.headerBlurb':
      "Chaque membre verse la même part dans la cagnotte. Quand la cagnotte est complète, c'est au tour du prochain membre de recevoir le versement.",
    'escrow.refresh': 'Actualiser',
    'escrow.refreshing': 'Vérification…',
    'escrow.signInHint':
      "Veuillez vous reconnecter pour payer votre part ou recevoir le versement. Votre session portefeuille doit être active pour que le téléphone signe la transaction — rien ne transite par notre serveur.",
    'escrow.loading': 'Recherche de la cagnotte de ce tour sur la blockchain…',
    'escrow.loadFailed':
      "We couldn't reach the network to check this round. It may already be open — retry in a moment.",
    'escrow.notOpen':
      "Ce tour n'est pas encore ouvert. Une fois que l'administrateur du cercle l'ouvre, les membres peuvent verser leur part et la première personne de la liste sera prête à recevoir.",
    'escrow.openRound': 'Ouvrir ce tour',
    'escrow.openingRound': 'Ouverture en cours…',
    'escrow.confirmingRound': "Confirmation de l'ouverture du tour…",
    'escrow.confirmingRoundNotice':
      "Votre transaction pour ouvrir ce tour est passée. En attente que le réseau affiche la nouvelle cagnotte — l'ouverture reste désactivée jusque-là, pour que le tour ne puisse pas être ouvert deux fois.",
    'escrow.confirmTimedOut':
      "Nous ne voyons toujours pas la nouvelle cagnotte. Actualisez et vérifiez que le tour n'est pas déjà ouvert avant de l'ouvrir à nouveau.",
    'escrow.roundAlreadyOpen':
      'Une cagnotte est déjà ouverte pour ce tour sur la blockchain. Actualisation pour vous la montrer.',
    'escrow.refunded':
      "Le tour {cycle} a été annulé et chaque versement est revenu au membre qui l'avait fait. L'administrateur du cercle peut rouvrir ce tour.",
    'escrow.reopenRound': 'Rouvrir ce tour',
    'escrow.onlyAdminOpens': "Seul l'administrateur du cercle peut ouvrir le tour.",
    'escrow.yourShare': 'Votre part ce tour',
    'escrow.whoseTurn': "C'est le tour de",
    'escrow.yourTurn': "C'est vous — votre versement est prêt.",
    'escrow.paymentsReceived': 'Versements reçus',
    'escrow.progressLabel': '{paid} sur {required} membres ont versé leur part pour ce tour',
    'escrow.ringCaption': 'Versements de ce tour',
    'escrow.status.receiving': 'Reçoit le versement',
    'escrow.status.paid': 'A versé',
    'escrow.status.pending': 'En attente',
    'escrow.alreadyPaid':
      '✓ Vous avez déjà versé votre part pour ce tour. En attente des autres membres.',
    'escrow.prompt.payYourShare':
      "Versez votre part et la cagnotte se rapproche d'être complète.",
    'escrow.action.payShare': 'Verser ma part — {amount}',
    'escrow.action.paying': 'Paiement en cours…',
    'escrow.prompt.collectPayout':
      "Tout le monde a payé. C'est votre tour — appuyez ci-dessous pour envoyer la cagnotte à votre portefeuille.",
    'escrow.action.collect': 'Récupérer mon versement',
    'escrow.action.collecting': 'Récupération…',
    'escrow.prompt.someoneElseCollects':
      'La cagnotte est complète. {recipient} peut récupérer son versement maintenant.',
    'escrow.completed':
      '✓ Tour {cycle} terminé. {recipient} a récupéré le versement. L\'administrateur peut ouvrir le prochain tour quand tout le monde est prêt.',
    'escrow.lastTx': 'Dernière transaction : {digest}',
    // Toasts
    'toast.roundOpened':
      'Le tour est ouvert — les membres peuvent maintenant verser leur part.',
    'toast.sharePaid': 'Merci ! Votre part est dans la cagnotte.',
    'toast.payoutSent': 'Votre versement est en route vers votre portefeuille.',
    'toast.signInAgain': 'Veuillez vous reconnecter pour continuer.',
    'toast.genericError': 'Quelque chose ne va pas : {error}',
    // Dashboard alerts
    'alerts.yourShareDue.title': 'Vous avez une part à verser',
    'alerts.yourShareDue.body':
      'Le cercle {circle} attend votre part — {amount}. Appuyez pour verser dans la cagnotte.',
    'alerts.yourTurn.title': "C'est à votre tour de récupérer",
    'alerts.unreadable':
      "Nous n'avons pas pu vérifier {count} de vos tontines pour le moment ; ce qui y est dû n'est donc pas affiché. Veuillez réessayer dans un instant.",
    'alerts.yourTurn.body':
      "Tous les membres de {circle} ont payé. Votre versement de {amount} est prêt — appuyez pour l'envoyer à votre portefeuille.",
    'alerts.adminOpenRound.title': 'Prêt à lancer le prochain tour ?',
    'alerts.adminOpenRound.body':
      "Le tour précédent est terminé. Ouvrez le tour {cycle} dans {circle} pour que les membres puissent commencer à verser.",
    // Navigation partagée / habillage
    'nav.learn': 'Découvrir',
    'nav.faq': 'FAQ',
    'nav.mainnetUpdates': 'Actus mainnet',
    'nav.login': 'Se connecter',
    'nav.openDashboard': 'Ouvrir le tableau de bord',
    'nav.testnet': 'Testnet',
    'nav.mainnet': 'Mainnet',
    'nav.viewing': 'Réseau affiché : {network}',
    'nav.freePlan': 'Forfait gratuit',
    'nav.premium': 'Premium',
    'nav.signOut': 'Se déconnecter',
    'nav.notifications': 'Notifications',
    // Page d'accueil
    'landing.eyebrow': "Cercles d'épargne tournante — pour la diaspora mondiale",
    'landing.heroTitle':
      "Le cercle d'épargne auquel votre famille fait déjà confiance — désormais avec des règles que personne ne peut contourner en silence.",
    'landing.heroSubtitle':
      "Les membres cotisent selon un calendrier, chacun reçoit la cagnotte à son tour. Njangi On-Chain conserve ce rythme exact et rend chaque cotisation et chaque versement autodétenu, planifié et vérifiable — aucun trésorier ne détient l'argent, aucune phrase secrète pour démarrer.",
    'landing.heroCardTitle': 'Commencez avec une identité familière',
    'landing.heroCardBody':
      "Connectez-vous avec un compte social. La création du portefeuille se fait en arrière-plan, pour démarrer avec moins de friction.",
    'landing.noSeedPhrase': 'Aucune phrase secrète requise pour commencer',
    'landing.builtForCircles': 'Conçu pour des cercles gérés par leurs membres, pas des comptes génériques',
    'landing.exploreHowItWorks': 'Découvrir le fonctionnement',
    'landing.joinReleaseList': "Rejoindre la liste de lancement mainnet",
    'landing.proof.liveCircles': 'Cercles actifs',
    'landing.proof.supportedAssets': 'Actifs pris en charge',
    'landing.proof.currentEnvironment': 'Environnement actuel',
    'landing.proof.syncing': 'Synchronisation',
    'landing.proof.custodyLabel': 'Garde',
    'landing.proof.custodyValue': 'Auto-détenue',
    'landing.heritageAlso':
      "Aussi appelé njangi, esusu, stokvel, tontine et bien d'autres noms.",
    'landing.signInTitle': 'Connectez-vous avec un compte familier',
    'landing.signInBody':
      "Utilisez Google, Facebook ou Apple avec zkLogin. La création du portefeuille se fait en arrière-plan, sans étape d'intégration crypto séparée.",
    'landing.networkSwitchTitle': 'Passer sur {network} ?',
    'landing.networkSwitchBody':
      "Les environnements réseau utilisent des adresses de portefeuille différentes. Le changement efface la session zkLogin active afin que vos soldes, cercles et historique restent alignés sur l'environnement choisi.",
    'landing.networkSwitchStay': 'Rester ici',
    'landing.networkSwitchConfirm': 'Passer sur {network}',
    'landing.features.eyebrow': "Pourquoi c'est conçu ainsi",
    'landing.features.title':
      "La confiance de la tradition, avec la clarté de l'infrastructure.",
    'landing.features.body':
      "L'objectif n'est pas de transformer un cercle d'épargne en produit de trading. L'objectif est d'aider les membres à savoir ce qui se passe, quand cela se passe et où circulent les fonds.",
    'landing.feature.sharedVisibility.title': 'Tout le monde voit le même registre',
    'landing.feature.sharedVisibility.body':
      "Les cotisations, l'ordre des versements et le prochain bénéficiaire sont visibles par tout le cercle — pas enfouis dans la messagerie ou le carnet d'une seule personne.",
    'landing.feature.selfCustody.title': 'Personne ne détient la cagnotte, sauf la blockchain',
    'landing.feature.selfCustody.body':
      "Les membres cotisent depuis leur propre portefeuille et y reçoivent leurs paiements. Njangi ne détient jamais de solde : aucun trésorier à relancer, et rien que nous puissions perdre.",
    'landing.feature.borderless.title': 'Un seul cercle, plusieurs pays',
    'landing.feature.borderless.body':
      "Les groupes de la diaspora restent synchronisés sans dépendre d'une seule banque, devise ou fuseau horaire. Épargnez ensemble, où que vous soyez.",
    'landing.feature.culturalContinuity.title': 'Le même cercle, moins de friction',
    'landing.feature.culturalContinuity.body':
      "La confiance et le rythme de votre njangi restent exactement les mêmes. Nous retirons seulement les tableurs, les rappels et les messages « tu as payé ? ».",
    'landing.workflow.eyebrow': 'Comment se déroule un cycle',
    'landing.workflow.title': 'Trois étapes, un rythme clair.',
    'landing.workflow.body':
      "Njangi On-Chain est conçu pour les communautés qui savent déjà épargner ensemble. Il apporte une structure plus claire, pas un nouveau modèle social.",
    'landing.workflow.step1.title': 'Connectez-vous, sans configurer de portefeuille',
    'landing.workflow.step1.body':
      "Utilisez Google, Apple ou Facebook. Votre portefeuille on-chain est créé en arrière-plan — aucune phrase secrète, aucune application à installer.",
    'landing.workflow.step2.title': 'Fixez les règles une fois, ensemble',
    'landing.workflow.step2.body':
      "Convenez des membres, des montants, du calendrier et de l'ordre des versements dès le départ. Tout le monde voit les mêmes règles, il n'y a donc rien à renégocier ensuite.",
    'landing.workflow.step3.title': 'Cotisez et soyez payé, selon le calendrier',
    'landing.workflow.step3.body':
      "À chaque tour, le versement part automatiquement vers le portefeuille du membre suivant. Suivez qui a cotisé et qui est le prochain — sans aucun message de relance.",
    'landing.launch.eyebrow': 'Lancement mainnet',
    'landing.launch.title': 'Suivez le lancement sans subir le bruit.',
    'landing.launch.body':
      "Le produit est disponible aujourd'hui pour l'exploration sur testnet. Rejoignez la liste de lancement pour recevoir le signal le plus clair sur la disponibilité en production, le calendrier de déploiement et l'accès anticipé.",
    'landing.launch.emailPlaceholder': 'Saisissez votre adresse e-mail',
    'landing.launch.notifyButton': 'Me prévenir du lancement mainnet',
    'landing.launch.signingUp': 'Inscription en cours...',
    'landing.launch.disclaimer':
      "Les mises à jour se limitent aux étapes importantes. Pas de remplissage hebdomadaire, pas de spam de masse.",
    'landing.faq.eyebrow': 'Questions fréquentes',
    'landing.faq.title': 'Quelques questions que les gens posent en premier.',
    'landing.faq.body':
      "Pour le contexte complet, les guides détaillés se trouvent dans les sections Découvrir et FAQ. Ceci couvre l'essentiel.",
    'landing.faq.learnLink': "En savoir plus sur les cercles d'épargne",
    'landing.faq.fullFaqLink': 'Voir la FAQ complète',
    'landing.heroPrimaryCta': 'Démarrer un cercle',
    'landing.heroCtaReassure':
      'Environ 30 secondes — connectez-vous avec Google, Apple ou Facebook. Aucun portefeuille à configurer.',
    'landing.testnetNote':
      "En ligne sur testnet aujourd'hui — explorez tout le parcours avec des fonds de test, sans argent réel en jeu.",
    'landing.faq.q1': "Qu'est-ce qu'un Njangi ?",
    'landing.faq.a1':
      "Un Njangi est une structure d'épargne communautaire tournante où les membres cotisent selon un calendrier commun et où chacun reçoit la somme mise en commun à son tour. Des systèmes similaires existent partout dans le monde sous de nombreux noms.",
    'landing.faq.q2': "Pourquoi mettre un cercle d'épargne sur la blockchain ?",
    'landing.faq.a2':
      "Le but n'est pas la nouveauté, mais la clarté. Les enregistrements on-chain rendent les cotisations, l'ordre des versements et les règlements plus faciles à vérifier, surtout lorsque les membres sont répartis dans plusieurs villes ou pays.",
    'landing.faq.q3': 'Les membres doivent-ils bien connaître la crypto ?',
    'landing.faq.a3':
      "Non. zkLogin allège l'intégration en permettant aux membres de commencer avec un compte social familier, tout en recevant un portefeuille lié au réseau sélectionné.",
    'landing.faq.q4': 'Que se passe-t-il quand je passe du testnet au mainnet ?',
    'landing.faq.a4':
      "Votre adresse de portefeuille change car chaque réseau a son propre état. L'application efface la session en cours pour que l'environnement sélectionné reste propre et cohérent.",
    'landing.tradition.eyebrow': 'Une tradition mondiale',
    'landing.tradition.title': 'Une tradition, vingt-cinq noms.',
    'landing.tradition.body':
      "Partout dans le monde, les communautés connaissent déjà l'épargne tournante. Njangi On-Chain est conçu pour respecter cette histoire plutôt que de l'aplatir en un schéma fintech générique.",
    'landing.footer.tagline':
      "Bâti sur Sui avec zkLogin pour un accès communautaire sans friction.",
    'landing.footer.rights': '© {year} Njangi On-Chain. Tous droits réservés.',
    // Page d'authentification
    'auth.title': 'Authentification du compte',
    'auth.whatsappTitle': 'Authentification WhatsApp',
    'auth.checking': "Vérification du statut d'authentification...",
    'auth.pleaseAuthenticate': 'Veuillez authentifier votre compte',
    'auth.pleaseAuthenticateWhatsapp':
      'Veuillez authentifier votre compte pour WhatsApp ({phone})',
    'auth.alreadyAuthenticated': 'Vous êtes déjà authentifié !',
    'auth.successTitle': 'Authentification réussie !',
    'auth.redirecting': 'Authentification réussie ! Redirection...',
    'auth.chooseMethod': 'Choisissez votre méthode de connexion préférée :',
    'auth.goToDashboard': 'Aller au tableau de bord',
    'auth.closePage': 'Fermer la page',
    'auth.poweredByZkLogin': 'Authentification sécurisée propulsée par zkLogin',
    // Création de cercle
    'create.eyebrow': 'Créer un cercle',
    'create.stepCounter': 'Étape {current} sur {total}',
    'create.step.type.label': 'Type de cercle',
    'create.step.type.title': 'Choisissez la structure du cercle',
    'create.step.type.description':
      "Commencez par le modèle de fonctionnement. Les cercles rotatifs reçoivent la cagnotte à tour de rôle ; les cercles à objectif (Premium) épargnent vers des jalons partagés.",
    'create.step.currency.label': 'Devise',
    'create.step.currency.title': 'Choisissez la devise de référence',
    'create.step.currency.description':
      "Définissez la devise que vos membres comprennent et avec laquelle ils planifient. SUI reste le rail de règlement sous-jacent.",
    'create.step.config.label': 'Configuration',
    'create.step.config.title': 'Définissez le fonctionnement du cercle',
    'create.step.config.description':
      "Définissez le nom, le montant du versement, la fréquence, le dépôt et les règles optionnelles qui guideront ce groupe.",
    'create.step.invites.label': 'Invitations',
    'create.step.invites.title': 'Invitez des membres dans le cercle',
    'create.step.invites.description':
      "Partagez le lien, préparez les invitations par e-mail et confiez le cercle aux personnes qui le géreront avec vous.",
    'create.circleNameLabel': 'Nom du cercle',
    'create.circleNamePlaceholder': 'Saisissez le nom de votre cercle',
    'create.cancel': 'Annuler',
    'create.nextInvite': 'Suivant : inviter des membres',
    'create.backToDashboard': 'Retour au tableau de bord',
    // Adhésion / découverte
    'join.eyebrow': 'Rejoindre le cercle',
    'join.reviewTerms':
      "Examinez les conditions de versement, envoyez une demande d'adhésion et attendez l'approbation de l'administrateur du cercle avant de participer.",
    'join.members': '{current} membres sur {max}',
    'join.requestsOpen': 'Demandes ouvertes',
    'join.requestsPaused': 'Demandes en pause',
    'join.contribution': 'Versement',
    'join.securityDeposit': 'Dépôt de garantie',
    'join.circleAdmin': 'Administrateur du cercle',
    'join.requestToJoin': 'Demander à rejoindre le cercle',
    'join.submitting': 'Envoi de la demande...',
    'join.alreadyMember': 'Déjà membre',
    'join.signInToRequest': "Connectez-vous pour demander l'accès",
    'join.signInBody':
      "Utilisez votre fournisseur préféré pour continuer. L'application vous ramènera à ce cercle après la connexion.",
    'join.backToDashboard': 'Retour au tableau de bord',
    'join.backToHome': "Retour à l'accueil",
    // Habillage de la page de versement
    'contribute.backToDashboard': 'Retour au tableau de bord',
    'contribute.eyebrow': 'Paiement du cercle',
    'contribute.title': 'Verser',
    'contribute.workspaceEyebrow': 'Espace de versement',
    'contribute.headingWithCircle': 'Verser à {circle}',
    'contribute.heading': 'Verser au cercle',
    'contribute.blurb':
      "Vérifiez l'état du portefeuille, les exigences du cercle et l'état du tour en cours avant de soumettre votre paiement.",
    // Habillage du tableau de bord
    'dashboard.eyebrow': 'Tableau de bord Njangi On-Chain',
    'dashboard.welcome': 'Bon retour{name}.',
    'dashboard.blurb':
      "Gardez vos cercles, vos versements et vos mouvements d'argent organisés dans un espace de travail apaisé.",
    'dashboard.refreshCircles': 'Actualiser les cercles',
    'dashboard.joinCircle': 'Rejoindre un cercle',
    'dashboard.newCircle': 'Nouveau cercle',
    'dashboard.emptyTitle': 'Aucun cercle pour le moment',
    'dashboard.emptyBody':
      "Commencez par créer un cercle ou rejoignez-en un avec un lien d'invitation.",
    'dashboard.emptyJoin': 'Rejoindre un cercle',
    'dashboard.emptyCreate': 'Créer un cercle',
    'dashboard.loadMore': 'Charger plus de cercles',
    'dashboard.loadingMore': 'Chargement des cercles...',
    'dashboard.roleAdmin': 'Administrateur',
    'dashboard.roleMember': 'Membre',
    // Page de tarifs
    'pricing.eyebrow': 'Tarifs',
    'pricing.title': "Une tarification simple qui ne touche jamais à votre épargne",
    'pricing.subtitle':
      "Gérez un cercle gratuitement, pour toujours. Premium ajoute des facilités de coordination pour les groupes plus importants — vos versements, vos paiements et la récupération restent en autodétention et gratuits sur tous les forfaits.",
    'pricing.comingSoonBanner': "Premium arrive bientôt — chaque forfait garde vos fonds en autodétention et gratuits.",
    'pricing.breadcrumbHome': 'Accueil',
    'pricing.breadcrumbPricing': 'Tarifs',
    'pricing.free': 'Gratuit',
    'pricing.alwaysFreeBadge': 'Toujours gratuit',
    'pricing.forever': 'pour toujours',
    'pricing.freeBlurb':
      "Tout ce dont un petit cercle a besoin pour épargner ensemble avec la clarté de la blockchain.",
    'pricing.premium': 'Premium',
    'pricing.comingSoon': 'Bientôt disponible',
    'pricing.yourPlan': 'Votre forfait',
    'pricing.forOrganizers': 'Pour les organisateurs',
    'pricing.perMonth': 'par mois',
    'pricing.premiumBlurb':
      "Pour les administrateurs qui coordonnent de plus grands groupes — plus de membres, plus de cercles, et des notifications là où vos membres discutent déjà.",
    'pricing.billedMonthly':
      "Facturé mensuellement via Stripe. Annulez à tout moment — vos cercles et vos fonds ne sont pas affectés à la fin d'un abonnement.",
    'pricing.ctaComingSoon': 'Bientôt disponible',
    'pricing.ctaSignInToUpgrade': 'Connectez-vous pour passer à Premium',
    'pricing.ctaManageSubscription': "Gérer l'abonnement",
    'pricing.ctaOpeningPortal': 'Ouverture du portail…',
    'pricing.ctaUpgrade': 'Passer à Premium',
    'pricing.ctaStartingCheckout': 'Démarrage du paiement…',
    'pricing.ctaGoToDashboard': 'Aller à votre tableau de bord',
    'pricing.ctaGetStarted': 'Commencer gratuitement',
    'pricing.cancelledNotice':
      "Le paiement a été annulé — rien n'a été débité. Vous pouvez passer à Premium quand vous le souhaitez.",
    'pricing.assuranceTitle': "Votre argent n'est jamais derrière un péage",
    'pricing.assuranceBody':
      "Njangi On-Chain est non dépositaire : les versements sont conservés en séquestre par cercle sur Sui, les paiements vont directement vers les portefeuilles des membres, et la récupération est initiée par les membres. Verser, recevoir un paiement, récupérer l'accès et retirer des fonds fonctionnent de la même façon sur les forfaits Gratuit et Premium — un abonnement n'ajoute que des facilités de coordination, jamais l'accès à votre épargne.",
    'pricing.faqTitle': 'Questions fréquentes',
    'pricing.faq.whoPays.q': 'Qui paie Premium ?',
    'pricing.faq.whoPays.a':
      "L'administrateur du cercle. Un seul abonnement couvre tous les cercles qu'il gère — les membres n'ont jamais rien à payer.",
    'pricing.faq.cancel.q': "Que se passe-t-il si j'annule ?",
    'pricing.faq.cancel.a':
      "Vos cercles continuent de fonctionner et chaque membre conserve un accès complet à ses fonds. Vous revenez simplement aux limites du forfait Gratuit pour les nouveaux cercles et fonctionnalités.",
    'pricing.faq.fees.q': "Y a-t-il d'autres frais ?",
    'pricing.faq.fees.a':
      "Uniquement les frais de réseau Sui standard (généralement quelques centimes), versés à la blockchain — pas à nous. Avec Premium, nous prenons en charge ces frais de réseau pour les cotisations et les retraits de vos membres (usage raisonnable), afin qu'ils n'aient jamais besoin de détenir de crypto pour le gaz. Sur le forfait Gratuit, les membres paient simplement leur petit frais de réseau.",
    'pricing.faq.gasFree.q': "Qu'est-ce que « sans frais de gaz pour les membres » ?",
    'pricing.faq.gasFree.a':
      "Chaque transaction Sui nécessite un petit frais de réseau (« gaz »), normalement payé en SUI. Lorsque vous souscrivez à Premium, votre abonnement couvre ce frais pour les cotisations et retraits de vos membres — ainsi une personne peut rejoindre votre cercle et y cotiser avec uniquement de l'USDC, sans avoir à acheter d'abord du SUI pour le gaz. Des limites d'usage raisonnable s'appliquent pour éviter les abus ; le flux d'argent lui-même n'est jamais bloqué.",
    'pricing.footerDisclaimer':
      "Premium couvre uniquement les fonctionnalités de coordination. Ce n'est pas un conseil financier, ni de la conservation, ni une garantie de rendement. L'usage de cryptomonnaies comporte des risques — vérifiez les règles applicables dans votre pays.",
    'pricing.free.feature.circles': "{count} cercle d'épargne",
    'pricing.free.feature.members': "Jusqu'à {count} membres par cercle",
    'pricing.free.feature.escrow': 'Tours de séquestre essentiels — verser et recevoir à tour de rôle',
    'pricing.free.feature.recovery': 'Récupération initiée par les membres, toujours incluse',
    'pricing.free.feature.zklogin': 'Connexion zkLogin avec portefeuilles en autodétention',
    'pricing.premium.feature.members': "Jusqu'à {count} membres par cercle",
    'pricing.premium.feature.circles': "Gérez jusqu'à {count} cercles à la fois",
    'pricing.premium.feature.whatsapp': 'Liaison WhatsApp + notifications de tour et de paiement',
    'pricing.premium.feature.goals': "Objectifs d'épargne intelligents pour vos cercles",
    'pricing.premium.feature.gasFree': 'Cotisations sans frais de gaz pour tous vos membres (usage raisonnable)',
    'pricing.premium.feature.analytics': 'Analyses du cercle et aperçus des versements',
    'pricing.premium.feature.everything': 'Tout ce qui est inclus dans Gratuit',
    'pricing.alwaysFreeNoteLabel': 'Toujours gratuit, sur tous les forfaits :',
    'pricing.alwaysFreeNoteBody':
      "recevoir votre paiement, la récupération initiée par les membres et le retrait de vos fonds ne nécessitent jamais d'abonnement.",
    // Fenêtre d'incitation à l'abonnement
    'billing.notNow': 'Pas maintenant',
    'billing.seePlans': 'Voir les forfaits',
    'billing.alwaysFreeNote':
      "Recevoir vos paiements, la récupération et le retrait de vos fonds sont toujours gratuits — Premium n'ajoute que des facilités de coordination.",
    'billing.generic.title': 'Ceci est une fonctionnalité Premium',
    'billing.generic.body': 'Passez à Premium pour la débloquer pour vos cercles.',
    'billing.whatsappSuite.title': 'Les notifications WhatsApp sont une fonctionnalité Premium',
    'billing.whatsappSuite.body':
      "Reliez votre cercle à WhatsApp pour que les membres reçoivent les rappels de tour et les alertes de paiement là où ils discutent déjà.",
    'billing.maxMembers.title': 'Les cercles plus grands sont une fonctionnalité Premium',
    'billing.maxMembers.body':
      "Les cercles gratuits réunissent quelques membres proches. Premium étend un cercle à la rotation complète prise en charge par le contrat.",
    'billing.maxCircles.title': "Plus de cercles, c'est une fonctionnalité Premium",
    'billing.maxCircles.body':
      "Le forfait Gratuit couvre un cercle. Premium vous permet d'organiser plusieurs cercles en parallèle.",
    'billing.smartGoals.title': 'Les objectifs intelligents sont une fonctionnalité Premium',
    'billing.smartGoals.body':
      "Fixez des objectifs d'épargne et des jalons pour votre cercle et suivez la progression à chaque tour.",
    'billing.analytics.title': "L'analyse est une fonctionnalité Premium",
    'billing.analytics.body':
      "Consultez l'historique des versements, les taux de ponctualité et les tendances des paiements de vos cercles.",

    // Interstitiel de dérive d'adresse (src/components/AddressDriftModal.tsx).
    'drift.title': 'Cette connexion a ouvert un compte différent',
    'drift.intro':
      'La connexion que vous venez d’effectuer vous a donné un compte différent de celui que vous utilisiez auparavant. Le problème vient de nous, pas de vous.',
    'drift.previousLabel': 'Votre compte précédent',
    'drift.currentLabel': 'Le compte actuel',
    'drift.whatNow':
      'Tout ce que vous aviez — vos tontines et votre argent — se trouve toujours sur le compte précédent. Rien n’a été perdu ni déplacé. Mais cette connexion ne peut pas y accéder, et nous ne pouvons pas transférer des fonds d’un compte à l’autre à votre place.',
    'drift.reassure': 'Nous avons été alertés automatiquement et nous examinons la situation.',
    'drift.canStill':
      'Vous pouvez toujours percevoir un versement qui vous est dû, demander un remboursement, et participer au vote de récupération de votre tontine.',
    'drift.cannotYet':
      'Rejoindre une tontine, en créer une, et payer une cotisation sont suspendus le temps de régler cela.',
    'drift.support': 'Veuillez contacter le support en mentionnant les deux comptes indiqués ci-dessus.',
    'drift.languageLabel': 'Langue',
    'drift.dismiss': 'J’ai compris',

    // Relevé de participation (Circle Record).
    'record.eyebrow': 'Relevé de tontine',
    'record.title': 'Relevé de participation',
    'record.generated': 'Généré le {date} · {network}',
    'record.sharedNote': 'Partagé avec vous par la personne à qui appartient ce relevé.',
    'record.summary.circlesJoined': 'Tontines rejointes',
    'record.summary.payoutsReceived': 'Versements reçus',
    'record.summary.completedRounds': 'Tours terminés',
    'record.summary.memberSince': 'Membre depuis',
    'record.fullFundingNote':
      'Un tour ne se termine que lorsque chaque membre a payé sa part en entier — sinon la tontine ne peut pas passer au membre suivant. Chaque tour terminé ci-dessous a donc été entièrement financé.',
    'record.circles.heading': 'Tontines',
    'record.circles.empty':
      'Pas encore de tontine. Dès que vous en rejoignez une, votre relevé commence à se construire ici.',
    'record.circle.untitled': 'Tontine sans nom',
    'record.circle.joined': 'Rejointe le {date}',
    'record.circle.completedRounds': 'Tours terminés',
    'record.circle.members': 'Membres',
    'record.circle.yourTurn': 'Votre tour',
    'record.circle.turnNotSet': 'Non défini',
    'record.circle.payout': 'Versement',
    'record.circle.payoutReceived': 'Reçu (tour {round})',
    'record.circle.payoutNotYet': 'Tour pas encore atteint',
    'record.circle.onTime': 'À temps',
    'record.circle.onTimeValue': '{onTime} sur {recorded} enregistrées',
    'record.verify.title': 'Comment vérifier ceci.',
    'record.verify.body':
      'Chaque chiffre ci-dessus provient des registres publics du réseau Sui. Ouvrez le lien d’une tontine pour lire les mêmes informations directement, sans dépendre de cette page.',
    'record.disclaimer':
      'Ceci est un relevé d’activité de tontine. Ce n’est ni un rapport de crédit, ni une note, ni une évaluation de la solvabilité de quiconque. Il montre ce qui s’est passé ; il ne note pas la personne à qui il appartient.',
    'record.page.loading': 'Lecture de votre relevé…',
    'record.page.loadFailed':
      'Impossible de lire votre relevé pour le moment. Vos tontines vont bien — c’est un problème de lecture des registres publics.',
    'record.page.retry': 'Réessayer',
    'record.page.signedOutTitle': 'Votre relevé',
    'record.page.signedOutBody': 'Connectez-vous pour voir votre relevé de tontine.',
    'record.page.signedOutCta': 'Aller à la connexion',
    'record.share.heading': 'Partager ou enregistrer',
    'record.share.blurb':
      'Un lien de partage permet à quelqu’un de lire ce relevé sans compte. Il cesse de fonctionner tout seul après la durée que vous choisissez, et vous pouvez le désactiver à tout moment.',
    'record.share.lasts': 'Durée du lien',
    'record.share.days': '{n} jours',
    'record.share.create': 'Créer le lien',
    'record.share.print': 'Imprimer',
    'record.share.download': 'Télécharger',
    'record.share.until': 'jusqu’au {date}',
    'record.share.revoke': 'Désactiver',
    'record.share.created': 'Lien créé',
    'record.share.createdCopied': 'Lien créé et copié',
    'record.share.createFailed': 'Impossible de créer le lien. Veuillez réessayer.',
    'record.share.revoked': 'Lien désactivé',
    'record.share.revokeFailed': 'Impossible de désactiver ce lien.',
    'record.shared.missingTitle': 'Ce lien n’est pas disponible',
    'record.shared.missingBody':
      'Il a peut-être expiré ou été désactivé par la personne qui l’a partagé. Demandez-lui un nouveau lien.',
    'record.shared.loadFailed': 'Impossible de charger ce relevé pour le moment. Veuillez réessayer sous peu.',
    'record.dashboard.title': 'Votre relevé',
    'record.dashboard.blurb': 'L’historique de vos tontines — à consulter, imprimer ou partager',
  },
  pcm: {
    // Escrow panel — Nigerian / Cameroonian Pidgin
    'escrow.sectionTitle': 'Di pot for dis round',
    'escrow.header.withCircle': '{circle} · round {cycle}',
    'escrow.header.noCircle': 'Round {cycle}',
    'escrow.headerBlurb':
      'Everybody dey pay di same share inside di pot. When di pot don full, na di next person for di list go collect.',
    'escrow.refresh': 'Check again',
    'escrow.refreshing': 'Dey check…',
    'escrow.signInHint':
      'Abeg sign in again so you fit pay inside di pot or collect your payout. Your phone go sign di transaction — our server no dey see am.',
    'escrow.loading': 'Dey find di pot for dis round for blockchain…',
    'escrow.loadFailed':
      "We couldn't reach the network to check this round. It may already be open — retry in a moment.",
    'escrow.notOpen':
      'Dis round neva open. Once di circle admin open am, people go fit pay dem share and di first person for di list go dey ready to collect.',
    'escrow.openRound': 'Open dis round',
    'escrow.openingRound': 'Dey open di round…',
    'escrow.onlyAdminOpens': 'Na only di admin fit open di round.',
    'escrow.yourShare': 'Your share for dis round',
    'escrow.whoseTurn': 'Who dey collect',
    'escrow.yourTurn': 'Na you — your payout don ready.',
    'escrow.paymentsReceived': 'Don already pay',
    'escrow.progressLabel': '{paid} out of {required} members don pay dem share for dis round',
    'escrow.ringCaption': 'Wetin people don pay dis round',
    'escrow.status.receiving': 'Dey collect',
    'escrow.status.paid': 'Don pay',
    'escrow.status.pending': 'Never pay',
    'escrow.alreadyPaid': '✓ You don pay your share for dis round. We dey wait di other members.',
    'escrow.prompt.payYourShare':
      'Pay your share and di pot dey move one step closer to full.',
    'escrow.action.payShare': 'Pay my share — {amount}',
    'escrow.action.paying': 'Dey pay…',
    'escrow.prompt.collectPayout':
      'Everybody don pay. Na your turn — tap down here make di pot enter your wallet straight.',
    'escrow.action.collect': 'Collect my payout',
    'escrow.action.collecting': 'Dey collect…',
    'escrow.prompt.someoneElseCollects':
      'Di pot don full. {recipient} go fit collect dem payout now.',
    'escrow.completed':
      '✓ Round {cycle} don finish. {recipient} don collect di payout. Admin fit open di next round when everybody ready.',
    'escrow.lastTx': 'Last transaction: {digest}',
    'toast.roundOpened': 'Di round don open — members fit pay dem share now.',
    'toast.sharePaid': 'Thanks! Your share dey inside di pot.',
    'toast.payoutSent': 'Your payout dey on di way to your wallet.',
    'toast.signInAgain': 'Abeg sign in again make we continue.',
    'toast.genericError': 'Something no work: {error}',
    'alerts.yourShareDue.title': 'You get share wey you never pay',
    'alerts.yourShareDue.body':
      '{circle} circle dey wait your share — {amount}. Tap make you pay inside di pot.',
    'alerts.yourTurn.title': 'Na your turn to collect',
    'alerts.yourTurn.body':
      'Everybody for {circle} don pay. Your payout of {amount} don ready — tap make e enter your wallet.',
    'alerts.adminOpenRound.title': 'You ready to start di next round?',
    'alerts.adminOpenRound.body':
      'Di last round don finish. Open round {cycle} for {circle} make members fit start to pay.',
  },
  sw: {
    // Escrow panel — Kiswahili
    'escrow.sectionTitle': 'Kibanda cha raundi hii',
    'escrow.header.withCircle': '{circle} · raundi {cycle}',
    'escrow.header.noCircle': 'Raundi {cycle}',
    'escrow.headerBlurb':
      'Kila mwanachama hulipa mchango sawa kwenye kibanda. Kibanda kikijaa, mwanachama anayefuata kwenye orodha huchukua malipo.',
    'escrow.refresh': 'Angalia tena',
    'escrow.refreshing': 'Inaangalia…',
    'escrow.signInHint':
      'Tafadhali ingia tena ili uweze kulipa mchango au kuchukua malipo. Kipindi cha pochi yako lazima kiwe hai ili simu yako isaini muamala — hakuna kinachotumwa kwa seva yetu.',
    'escrow.loading': 'Tunatafuta kibanda cha raundi hii kwenye blockchain…',
    'escrow.loadFailed':
      "We couldn't reach the network to check this round. It may already be open — retry in a moment.",
    'escrow.notOpen':
      'Raundi hii bado haijafunguliwa. Msimamizi wa duara akiifungua, wanachama wataweza kulipa mchango wao na mtu wa kwanza kwenye orodha atakuwa tayari kuchukua malipo.',
    'escrow.openRound': 'Fungua raundi hii',
    'escrow.openingRound': 'Inafungua raundi…',
    'escrow.onlyAdminOpens': 'Msimamizi wa duara pekee anaweza kufungua raundi.',
    'escrow.yourShare': 'Mchango wako raundi hii',
    'escrow.whoseTurn': 'Zamu ni ya nani',
    'escrow.yourTurn': 'Ni wewe — malipo yako yanakusubiri.',
    'escrow.paymentsReceived': 'Michango iliyopokelewa',
    'escrow.progressLabel': '{paid} kati ya {required} wanachama wameshalipa raundi hii',
    'escrow.alreadyPaid':
      '✓ Umeshalipa mchango wako raundi hii. Tunasubiri wanachama wengine.',
    'escrow.prompt.payYourShare':
      'Lipa mchango wako na kibanda kinakaribia kujaa.',
    'escrow.action.payShare': 'Lipa mchango wangu — {amount}',
    'escrow.action.paying': 'Inalipa…',
    'escrow.prompt.collectPayout':
      'Wote wameshalipa. Ni zamu yako — bofya hapa chini ili kibanda kiende moja kwa moja kwenye pochi yako.',
    'escrow.action.collect': 'Chukua malipo yangu',
    'escrow.action.collecting': 'Inakusanya…',
    'escrow.prompt.someoneElseCollects':
      'Kibanda kimejaa. {recipient} anaweza kuchukua malipo yake sasa.',
    'escrow.completed':
      '✓ Raundi {cycle} imekamilika. {recipient} amechukua malipo. Msimamizi anaweza kufungua raundi inayofuata wakati wote wako tayari.',
    'escrow.lastTx': 'Muamala wa mwisho: {digest}',
    'toast.roundOpened': 'Raundi imefunguliwa — wanachama wanaweza kulipa mchango wao.',
    'toast.sharePaid': 'Asante! Mchango wako uko kwenye kibanda.',
    'toast.payoutSent': 'Malipo yako yanaelekea kwenye pochi yako.',
    'toast.signInAgain': 'Tafadhali ingia tena ili kuendelea.',
    'toast.genericError': 'Kuna tatizo: {error}',
    'alerts.yourShareDue.title': 'Una mchango wa kulipa',
    'alerts.yourShareDue.body':
      'Duara {circle} linakusubiri mchango wako — {amount}. Bofya kulipa kwenye kibanda.',
    'alerts.yourTurn.title': 'Ni zamu yako kuchukua',
    'alerts.yourTurn.body':
      'Wanachama wote wa {circle} wameshalipa. Malipo yako ya {amount} yako tayari — bofya yaende kwenye pochi yako.',
    'alerts.adminOpenRound.title': 'Uko tayari kuanza raundi inayofuata?',
    'alerts.adminOpenRound.body':
      'Raundi iliyopita imekwisha. Fungua raundi {cycle} kwenye {circle} ili wanachama waanze kulipa.',
  },
  am: {
    // Escrow panel — Amharic (አማርኛ). LTR, Ge'ez script. Polish pass by
    // a native speaker encouraged before production rollout.
    'escrow.sectionTitle': 'የዚህ ዙር ገንዘብ',
    'escrow.header.withCircle': '{circle} · ዙር {cycle}',
    'escrow.header.noCircle': 'ዙር {cycle}',
    'escrow.headerBlurb':
      'እያንዳንዱ አባል ተመሳሳይ መጠን ወደ ገንዘቡ ያስገባል። ገንዘቡ ሲሞላ፣ በመዞሪያው ዝርዝር ላይ ያለው ቀጣይ አባል ክፍያውን ይወስዳል።',
    'escrow.refresh': 'እንደገና ያረጋግጡ',
    'escrow.refreshing': 'እያረጋገጠ ነው…',
    'escrow.signInHint':
      'ወደ ገንዘቡ ለመክፈል ወይም ክፍያ ለመሰብሰብ እባክዎ እንደገና ይግቡ። የኪስ ቦርሳ ክፍለ ጊዜው ንቁ መሆን አለበት — ወደ አገልጋያችን የሚላክ ምንም የለም።',
    'escrow.loading': 'የዚህን ዙር ገንዘብ ከብሎክቼን ላይ በማፈላለግ ላይ…',
    'escrow.loadFailed':
      "We couldn't reach the network to check this round. It may already be open — retry in a moment.",
    'escrow.notOpen':
      'ይህ ዙር እስካሁን አልተከፈተም። አስተዳዳሪው ሲከፍተው አባላት ድርሻቸውን መክፈል ይችላሉ፣ የመጀመሪያው ሰው ክፍያ ለመውሰድ ዝግጁ ይሆናል።',
    'escrow.openRound': 'ይህንን ዙር ክፈት',
    'escrow.openingRound': 'ዙሩን በመክፈት ላይ…',
    'escrow.onlyAdminOpens': 'ዙሩን መክፈት የሚችለው የክበቡ አስተዳዳሪ ብቻ ነው።',
    'escrow.yourShare': 'የእርስዎ ድርሻ በዚህ ዙር',
    'escrow.whoseTurn': 'የማን ተራ ነው',
    'escrow.yourTurn': 'የእርስዎ ነው — ክፍያዎ ተዘጋጅቷል።',
    'escrow.paymentsReceived': 'የተቀበሉ ክፍያዎች',
    'escrow.progressLabel': 'ከ {required} አባላት ውስጥ {paid} በዚህ ዙር ከፍለዋል',
    'escrow.alreadyPaid': '✓ የእርስዎን ድርሻ በዚህ ዙር ከፍለዋል። ሌሎች አባላትን እየጠበቅን ነው።',
    'escrow.prompt.payYourShare':
      'ድርሻዎን ይክፈሉ፣ ገንዘቡ ወደ መሞላት አንድ እርምጃ ይጠጋል።',
    'escrow.action.payShare': 'የእኔን ድርሻ ይክፈሉ — {amount}',
    'escrow.action.paying': 'በመክፈል ላይ…',
    'escrow.prompt.collectPayout':
      'ሁሉም ሰው ከፍሏል። የእርስዎ ተራ ነው — ከታች ይጫኑ እና ገንዘቡ ቀጥታ ወደ ኪስ ቦርሳዎ ይገባል።',
    'escrow.action.collect': 'ክፍያዬን ውሰድ',
    'escrow.action.collecting': 'በመሰብሰብ ላይ…',
    'escrow.prompt.someoneElseCollects':
      'ገንዘቡ ሞልቷል። {recipient} አሁን ክፍያውን ሊወስድ ይችላል።',
    'escrow.completed':
      '✓ ዙር {cycle} ተጠናቅቋል። {recipient} ክፍያውን ወስዷል። ሁሉም ሲዘጋጅ አስተዳዳሪው ቀጣዩን ዙር ሊከፍት ይችላል።',
    'escrow.lastTx': 'የመጨረሻ ግብይት: {digest}',
    'toast.roundOpened': 'ዙሩ ተከፍቷል — አባላት አሁን ድርሻቸውን ሊከፍሉ ይችላሉ።',
    'toast.sharePaid': 'እናመሰግናለን! ድርሻዎ በገንዘቡ ውስጥ ነው።',
    'toast.payoutSent': 'ክፍያዎ ወደ ኪስ ቦርሳዎ በመንገድ ላይ ነው።',
    'toast.signInAgain': 'ለመቀጠል እባክዎ እንደገና ይግቡ።',
    'toast.genericError': 'አንድ ነገር ስህተት ነው: {error}',
    'alerts.yourShareDue.title': 'ሊከፍሉት የሚገባ ድርሻ አለዎት',
    'alerts.yourShareDue.body':
      'የ {circle} ክበብ የእርስዎን ድርሻ እየጠበቀ ነው — {amount}። ለመክፈል ይጫኑ።',
    'alerts.yourTurn.title': 'ክፍያ የመሰብሰብ ተራዎ ነው',
    'alerts.yourTurn.body':
      'የ {circle} አባላት ሁሉ ከፍለዋል። የ {amount} ክፍያዎ ተዘጋጅቷል — ወደ ኪስ ቦርሳዎ ለመላክ ይጫኑ።',
    'alerts.adminOpenRound.title': 'ቀጣዩን ዙር ለመጀመር ዝግጁ ነዎት?',
    'alerts.adminOpenRound.body':
      'ያለፈው ዙር ተጠናቅቋል። አባላት መክፈል እንዲጀምሩ በ {circle} ውስጥ ዙር {cycle}ን ይክፈቱ።',
  },
  ar: {
    // Escrow panel — Arabic (العربية). RTL; LocaleDirSync flips html dir.
    'escrow.sectionTitle': 'صندوق هذه الجولة',
    'escrow.header.withCircle': '{circle} · الجولة {cycle}',
    'escrow.header.noCircle': 'الجولة {cycle}',
    'escrow.headerBlurb':
      'يدفع كل عضو الحصة نفسها في الصندوق. عندما يمتلئ الصندوق، يستلم العضو التالي في قائمة الدوران المبلغ.',
    'escrow.refresh': 'تحديث الحالة',
    'escrow.refreshing': 'جاري التحقق…',
    'escrow.signInHint':
      'يرجى تسجيل الدخول مرة أخرى للدفع في الصندوق أو تحصيل المستحقات. يجب أن تكون جلسة المحفظة نشطة ليوقّع هاتفك المعاملة — لا يُرسَل أي شيء إلى خادمنا.',
    'escrow.loading': 'جاري البحث عن صندوق هذه الجولة على البلوكتشين…',
    'escrow.loadFailed':
      "We couldn't reach the network to check this round. It may already be open — retry in a moment.",
    'escrow.notOpen':
      'لم تُفتح هذه الجولة بعد. فور فتحها من قِبَل مشرف الدائرة، يمكن للأعضاء دفع حصتهم وسيكون الشخص الأول في القائمة جاهزاً للاستلام.',
    'escrow.openRound': 'افتح هذه الجولة',
    'escrow.openingRound': 'جاري فتح الجولة…',
    'escrow.onlyAdminOpens': 'يمكن لمشرف الدائرة فقط فتح الجولة.',
    'escrow.yourShare': 'حصتك في هذه الجولة',
    'escrow.whoseTurn': 'دور من',
    'escrow.yourTurn': 'إنه دورك — مستحقاتك جاهزة.',
    'escrow.paymentsReceived': 'الدفعات المستلمة',
    'escrow.progressLabel': '{paid} من أصل {required} عضواً دفعوا حصتهم في هذه الجولة',
    'escrow.alreadyPaid': '✓ لقد دفعت حصتك في هذه الجولة. بانتظار الأعضاء الآخرين.',
    'escrow.prompt.payYourShare': 'ادفع حصتك لتقترب الصندوق خطوة من الامتلاء.',
    'escrow.action.payShare': 'ادفع حصتي — {amount}',
    'escrow.action.paying': 'جاري الدفع…',
    'escrow.prompt.collectPayout':
      'لقد دفع الجميع. إنه دورك — اضغط أدناه لإرسال الصندوق مباشرةً إلى محفظتك.',
    'escrow.action.collect': 'استلم مستحقاتي',
    'escrow.action.collecting': 'جاري الاستلام…',
    'escrow.prompt.someoneElseCollects':
      'الصندوق ممتلئ. يمكن لـ {recipient} استلام مستحقاته الآن.',
    'escrow.completed':
      '✓ اكتملت الجولة {cycle}. لقد استلم {recipient} المستحقات. يمكن للمشرف فتح الجولة التالية عندما يكون الجميع جاهزاً.',
    'escrow.lastTx': 'آخر معاملة: {digest}',
    'toast.roundOpened': 'الجولة مفتوحة الآن — يمكن للأعضاء دفع حصتهم.',
    'toast.sharePaid': 'شكراً لك! حصتك في الصندوق.',
    'toast.payoutSent': 'مستحقاتك في طريقها إلى محفظتك.',
    'toast.signInAgain': 'يرجى تسجيل الدخول مرة أخرى للمتابعة.',
    'toast.genericError': 'حدث خطأ ما: {error}',
    'alerts.yourShareDue.title': 'عليك حصة لدفعها',
    'alerts.yourShareDue.body':
      'تنتظر دائرة {circle} حصتك — {amount}. اضغط للدفع في الصندوق.',
    'alerts.yourTurn.title': 'حان دورك للاستلام',
    'alerts.yourTurn.body':
      'لقد دفع جميع أعضاء {circle}. مستحقاتك البالغة {amount} جاهزة — اضغط لإرسالها إلى محفظتك.',
    'alerts.adminOpenRound.title': 'هل أنت جاهز لبدء الجولة التالية؟',
    'alerts.adminOpenRound.body':
      'انتهت الجولة السابقة. افتح الجولة {cycle} في {circle} ليبدأ الأعضاء بالدفع.',
  },
  fa: {
    // Escrow panel — Persian / Farsi (فارسی). RTL.
    'escrow.sectionTitle': 'صندوق این دور',
    'escrow.header.withCircle': '{circle} · دور {cycle}',
    'escrow.header.noCircle': 'دور {cycle}',
    'escrow.headerBlurb':
      'هر عضو سهم یکسانی به صندوق پرداخت می‌کند. وقتی صندوق پر شد، نفر بعدی در لیست چرخش مبلغ را دریافت می‌کند.',
    'escrow.refresh': 'به‌روزرسانی وضعیت',
    'escrow.refreshing': 'در حال بررسی…',
    'escrow.signInHint':
      'لطفاً برای پرداخت سهم یا دریافت مبلغ دوباره وارد شوید. نشست کیف‌پول باید فعال باشد تا گوشی شما تراکنش را امضا کند — چیزی به سرور ما ارسال نمی‌شود.',
    'escrow.loading': 'در حال جست‌وجوی صندوق این دور روی بلاک‌چین…',
    'escrow.loadFailed':
      "We couldn't reach the network to check this round. It may already be open — retry in a moment.",
    'escrow.notOpen':
      'این دور هنوز باز نشده است. به‌محض اینکه مدیر حلقه آن را باز کند، اعضا می‌توانند سهم خود را پرداخت کنند و نفر اول لیست برای دریافت آماده است.',
    'escrow.openRound': 'این دور را باز کن',
    'escrow.openingRound': 'در حال باز کردن دور…',
    'escrow.onlyAdminOpens': 'تنها مدیر حلقه می‌تواند دور را باز کند.',
    'escrow.yourShare': 'سهم شما در این دور',
    'escrow.whoseTurn': 'نوبت چه کسی است',
    'escrow.yourTurn': 'نوبت شماست — مبلغ شما آماده است.',
    'escrow.paymentsReceived': 'پرداخت‌های دریافت‌شده',
    'escrow.progressLabel': '{paid} از {required} عضو در این دور سهم خود را پرداخت کرده‌اند',
    'escrow.alreadyPaid': '✓ شما سهم خود را در این دور پرداخت کرده‌اید. در انتظار سایر اعضا.',
    'escrow.prompt.payYourShare': 'سهم خود را پرداخت کنید تا صندوق یک قدم به پر شدن نزدیک شود.',
    'escrow.action.payShare': 'سهم من را پرداخت کن — {amount}',
    'escrow.action.paying': 'در حال پرداخت…',
    'escrow.prompt.collectPayout':
      'همه پرداخت کرده‌اند. نوبت شماست — روی دکمه زیر بزنید تا صندوق مستقیم به کیف‌پول شما منتقل شود.',
    'escrow.action.collect': 'مبلغ خود را دریافت کن',
    'escrow.action.collecting': 'در حال دریافت…',
    'escrow.prompt.someoneElseCollects':
      'صندوق پر است. {recipient} اکنون می‌تواند مبلغ خود را دریافت کند.',
    'escrow.completed':
      '✓ دور {cycle} به پایان رسید. {recipient} مبلغ را دریافت کرده است. مدیر می‌تواند هر زمان که همه آماده بودند دور بعدی را باز کند.',
    'escrow.lastTx': 'آخرین تراکنش: {digest}',
    'toast.roundOpened': 'دور باز شد — اعضا اکنون می‌توانند سهم خود را پرداخت کنند.',
    'toast.sharePaid': 'ممنون! سهم شما در صندوق است.',
    'toast.payoutSent': 'مبلغ شما به‌سوی کیف‌پول‌تان در راه است.',
    'toast.signInAgain': 'لطفاً برای ادامه دوباره وارد شوید.',
    'toast.genericError': 'مشکلی پیش آمد: {error}',
    'alerts.yourShareDue.title': 'یک سهم برای پرداخت دارید',
    'alerts.yourShareDue.body':
      'حلقه {circle} منتظر سهم شماست — {amount}. برای پرداخت به صندوق بزنید.',
    'alerts.yourTurn.title': 'نوبت شما برای دریافت است',
    'alerts.yourTurn.body':
      'همه اعضای {circle} پرداخت کرده‌اند. مبلغ {amount} شما آماده است — برای ارسال به کیف‌پول بزنید.',
    'alerts.adminOpenRound.title': 'برای شروع دور بعدی آماده‌اید؟',
    'alerts.adminOpenRound.body':
      'دور قبلی به پایان رسید. دور {cycle} را در {circle} باز کنید تا اعضا شروع به پرداخت کنند.',
  },
};

// Start at the SSR default so the first CLIENT render matches the server HTML
// (no hydration mismatch). The persisted/browser locale is applied AFTER mount
// via hydrateLocale() — see LocaleDirSync.
let currentLocale: Locale = 'en';
const listeners = new Set<(locale: Locale) => void>();

function detectLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED_LOCALES.includes(stored as Locale)) {
      return stored as Locale;
    }
    const browserLang = window.navigator.language?.slice(0, 2).toLowerCase();
    if (browserLang && SUPPORTED_LOCALES.includes(browserLang as Locale)) {
      return browserLang as Locale;
    }
  } catch {
    /* ignore storage / navigator failures */
  }
  return 'en';
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Apply the persisted / browser locale on the CLIENT, after hydration. Kept out
 * of module init so SSR and the first client render both use 'en' (matching the
 * server HTML); call this once from a mount effect to switch to the real locale.
 */
export function hydrateLocale(): void {
  if (typeof window === 'undefined') return;
  const detected = detectLocale();
  if (detected !== currentLocale) setLocale(detected);
}

export function setLocale(locale: Locale): void {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  currentLocale = locale;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* ignore */
    }
  }
  listeners.forEach((listener) => listener(locale));
}

export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICTIONARIES[currentLocale] ?? DICTIONARIES.en;
  const raw = dict[key] ?? DICTIONARIES.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) => {
    const value = vars[name];
    return value === undefined || value === null ? `{${name}}` : String(value);
  });
}

export const SUPPORTED_LOCALE_OPTIONS: Array<{ code: Locale; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'pcm', label: 'Pidgin' },
  { code: 'sw', label: 'Kiswahili' },
  { code: 'am', label: 'አማርኛ' },
  { code: 'ar', label: 'العربية' },
  { code: 'fa', label: 'فارسی' },
];
