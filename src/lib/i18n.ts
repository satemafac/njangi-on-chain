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

const DICTIONARIES: Record<Locale, StringDict> = {
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
    'escrow.notOpen':
      "This round hasn't been opened yet. Once the circle admin opens it, members can pay their share and the first person on the list will be ready to collect.",
    'escrow.openRound': 'Open this round',
    'escrow.openingRound': 'Opening round…',
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
    'alerts.yourTurn.body':
      'Everyone in {circle} has paid. Your payout of {amount} is ready — tap to send it to your wallet.',
    'alerts.adminOpenRound.title': 'Ready to start the next round?',
    'alerts.adminOpenRound.body':
      'The previous round finished. Open round {cycle} in {circle} so members can start paying.',
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
    'escrow.notOpen':
      "Ce tour n'est pas encore ouvert. Une fois que l'administrateur du cercle l'ouvre, les membres peuvent verser leur part et la première personne de la liste sera prête à recevoir.",
    'escrow.openRound': 'Ouvrir ce tour',
    'escrow.openingRound': 'Ouverture en cours…',
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
    'alerts.yourTurn.body':
      "Tous les membres de {circle} ont payé. Votre versement de {amount} est prêt — appuyez pour l'envoyer à votre portefeuille.",
    'alerts.adminOpenRound.title': 'Prêt à lancer le prochain tour ?',
    'alerts.adminOpenRound.body':
      "Le tour précédent est terminé. Ouvrez le tour {cycle} dans {circle} pour que les membres puissent commencer à verser.",
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

let currentLocale: Locale = detectLocale();
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
