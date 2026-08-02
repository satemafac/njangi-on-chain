// rosca-terms.ts — the glossary behind /learn/[term].
//
// Every entry here is a rotating savings circle: a group contributes a fixed
// amount on a shared schedule, and each cycle one member takes the whole pool,
// until everyone has had a turn. Economists call the shape a ROSCA. What
// changes between entries is the culture, the ordering rule, and the degree of
// formality — which is exactly what makes each page worth writing separately.
//
// SCOPE: these 14 terms deliberately exclude njangi, ROSCA, tontine and susu,
// which already have their own long-form pages under /learn. Adding them here
// too would split the ranking signal for the site's four best keywords across
// two URLs apiece.
//
// COPY RULES (docs/compliance-roadmap-cex-dex-non-kyc.md §A3, enforced by
// `npm run check:copy` — src/content is in its SCAN_DIRS):
//   - Never: the interest/returns/yield family, invest or investment,
//     guaranteed, earn, the deposit-taking phrase for a bank product, or
//     "deposit" used as a noun for the pot. (Listing the banned phrases
//     verbatim here would trip the guard on this very file.)
//   - Describing a tradition's own mechanics is fine, but describe them in
//     plain language rather than borrowing finance vocabulary. Where a
//     tradition genuinely involves a discount or a fee (chit funds, ajo), say
//     so concretely — accuracy matters more than comfort — without adopting
//     that vocabulary for our own product.
//   - `regulatoryNote` exists for traditions that are a licensed activity
//     somewhere. Use it. We are coordination software, not the institution.

export interface RoscaTerm {
  /** URL segment under /learn/. */
  slug: string;
  /** Display name, as a speaker of the language would write it. */
  term: string;
  pronunciation?: string;
  /** Spellings and near-synonyms people search for. Feeds DefinedTerm.alternateName. */
  alsoKnownAs: string[];
  /** Where the practice is native. */
  region: string;
  /** Language the word comes from, and its literal sense where known. */
  etymology: string;
  /** <=160 chars. Used as the meta description and the DefinedTerm description. */
  shortDefinition: string;
  typicalSize: string;
  typicalCycle: string;
  /** How the turn order gets decided — the single biggest difference between traditions. */
  orderingRule: string;
  origin: string[];
  howItRuns: string[];
  /** What makes this one genuinely different. The reason the page exists. */
  distinctive: string[];
  diaspora: string[];
  /** Shown as a callout. Required where the practice is a licensed activity. */
  regulatoryNote?: string;
  /** Slugs from this file, or absolute paths to the four pillar pages. */
  related: string[];
  published: string;
  modified: string;
}

export const ROSCA_TERMS: RoscaTerm[] = [
  {
    slug: 'chit-fund',
    term: 'Chit fund',
    pronunciation: 'chit fund',
    alsoKnownAs: ['Chitty', 'Kuri', 'Chit', 'Chit scheme'],
    region: 'India, especially Kerala, Tamil Nadu, Andhra Pradesh and Karnataka',
    etymology:
      'From the Hindi and Marathi "chitthi", a written note or slip — the slips members once drew to decide whose turn it was.',
    shortDefinition:
      'An Indian rotating savings circle in which members bid for early access to the pool, and the discount they accept is shared out among everyone else.',
    typicalSize: '10 to 50 members, matched to the number of months in the cycle',
    typicalCycle: 'Monthly, running for as many months as there are members',
    orderingRule: 'By auction — members bid a discount, and the lowest taker goes first',
    origin: [
      'The chit fund is among the most thoroughly documented rotating savings traditions anywhere, partly because India began regulating it more than a century ago. Its recognisable modern form emerged in Kerala, where it has been woven into household and small-business life for generations, and where the state itself runs one of the largest chit operators.',
      'The name comes from the slips of paper — "chitthi" — that members once drew from a pot to settle whose turn had come. That lottery version still exists. But what made the chit fund unusual, and what spread it across southern India, was the shift from drawing lots to bidding.',
    ],
    howItRuns: [
      'A group agrees on a monthly amount and a length: twenty members paying a fixed sum for twenty months, so each member puts in exactly what they eventually take out. So far it is an ordinary rotating circle.',
      'The difference arrives at the auction. Each month, any member who wants the pool early states the discount they are willing to accept — they will take less than the full amount. The member willing to give up the most takes the pool that month, and the sum they gave up is divided among everyone else, usually after the organiser takes a commission for running the group.',
      'The effect is a self-sorting queue. A member with an urgent need — a medical bill, school fees, restocking a shop — can move to the front by accepting less. A member with no urgency waits, and their patience is compensated out of other people\'s discounts. Nobody is assigned a position; the group sorts itself by how badly each member needs the money right now.',
    ],
    distinctive: [
      'Almost every other tradition on this list settles turn order once, by agreement or by lot, and then holds it. The chit fund re-decides every single month, and prices urgency openly rather than making people negotiate it socially. That is a genuinely different mechanism, not a regional variation in vocabulary.',
      'It is also the most institutionalised. Registered chit funds are run by licensed companies, with a "foreman" who organises the group, holds security, and takes a capped commission — typically around five per cent of the pool. Alongside them sits a very large informal sector of workplace and neighbourhood chits run entirely on trust, which is closer to how the other traditions here operate.',
    ],
    diaspora: [
      'Indian communities abroad — in the Gulf states, Singapore, Malaysia, the United Kingdom, the United States and Canada — carry chits with them, though usually in the simpler lottery form rather than the full auction. Among Gulf workers in particular they are a common way to convert a steady wage into an occasional lump sum that can be sent home.',
      'The friction is the same one every diaspora circle hits: members are spread across countries, currencies and time zones, and the person holding the money is holding it somewhere most of the group cannot see. Keeping the schedule and the record in one shared place is the part that stops working first.',
    ],
    regulatoryNote:
      'Chit funds are a regulated financial activity in India under the Chit Funds Act, 1982, and registered chit businesses are licensed and supervised by state governments. Njangi On-Chain is coordination software. It is not a chit fund company, it is not a registered chit fund, it does not act as a foreman, and it never holds or directs members\' money. This page is background on the tradition, not an offer to operate a chit.',
    related: ['/learn/blockchain-rosca', 'paluwagan', 'hui', 'pandero'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'tanda',
    term: 'Tanda',
    pronunciation: 'TAHN-dah',
    alsoKnownAs: ['Tanda mexicana', 'Cundina', 'Rueda', 'Vaquita'],
    region: 'Mexico, and Mexican communities across the United States',
    etymology:
      'Spanish for a turn, a shift, or a batch — the same sense as taking your turn at something.',
    shortDefinition:
      'A Mexican rotating savings circle: everyone pays the same amount each round, and members take the full pool in a turn order agreed at the start.',
    typicalSize: '10 to 15 members',
    typicalCycle: 'Weekly or fortnightly, often matched to payday',
    orderingRule: 'Fixed at the start, by lottery or by negotiation over who needs it soonest',
    origin: [
      'The tanda is the everyday Mexican answer to a problem banks handle badly: needing a useful amount of money at once, on a modest and irregular income, without a credit history. It runs in workplaces, markets, extended families and neighbourhoods, and it is common enough that most people have either been in one or been asked to join one.',
      'The word simply means a turn or a batch. There is no institution behind it and, in the informal form, no paperwork — which is both why it works and why it sometimes does not.',
    ],
    howItRuns: [
      'An organiser gathers people who know each other, sets the amount and the rhythm — very often tied to payday, so contributions come out of money that has not yet been spent — and fixes the order. Order is settled by drawing numbers, or by open discussion: someone with a deadline asks for an early turn and the group agrees.',
      'Each round every member hands over the same amount, and one member takes the whole pool. The organiser chases late payments and is generally expected to cover a shortfall personally rather than let the round fail, which is why the role usually falls to someone with standing in the group.',
      'The last position is the least popular, since that member has effectively lent to everyone else for the whole cycle without ever having had the use of the pool early. Groups handle this in different ways: rotating who goes last between cycles, or letting the organiser take it as the price of the role.',
    ],
    distinctive: [
      'Tandas are unusually tightly coupled to wage cycles. Where an Indian chit or an Ethiopian equb typically runs monthly, a tanda often runs weekly or fortnightly and is deliberately timed so the contribution leaves before the money is absorbed by daily costs. It is as much a commitment device as a way of pooling.',
      'The other distinguishing feature is how informal it stays. Mexico has no equivalent of India\'s Chit Funds Act or South Africa\'s stokvel associations. There is no registry, no standard contract, and no external body to appeal to — the whole structure rests on the fact that the members see each other regularly.',
    ],
    diaspora: [
      'Tandas travelled north with Mexican migration and are widespread in Mexican-American communities, especially where members are undocumented or thin-filed and effectively locked out of ordinary credit. Community organisations in California, Texas and Illinois have run formal versions specifically so that participation can be recorded and used to build a credit file.',
      'Cross-border tandas — some members in Mexico, others in the United States — are common and are exactly where the informal structure strains. Contributions arrive through different channels in two currencies, and no member can see the whole picture except the organiser.',
    ],
    related: ['cundina', 'pandero', '/learn/blockchain-rosca', 'paluwagan'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'stokvel',
    term: 'Stokvel',
    pronunciation: 'STOK-fel',
    alsoKnownAs: ['Gooi-gooi', 'Umgalelo', 'Motshelo', 'Mahodisana'],
    region: 'South Africa, with related practices across Southern Africa',
    etymology:
      'From the English "stock fair" — the nineteenth-century cattle auctions in the Eastern Cape where farm workers pooled money and later met to socialise.',
    shortDefinition:
      'A South African rotating savings club, ranging from small informal groups to constituted societies with written rules and bank accounts.',
    typicalSize: '12 to 30 members, though large grocery and burial clubs run into the hundreds',
    typicalCycle: 'Monthly, with an annual payout cycle for grocery clubs',
    orderingRule: 'Set by the club constitution — commonly by rotation, sometimes by need',
    origin: [
      'The stokvel has an unusually traceable origin. It grew out of the "stock fairs" of the nineteenth-century Eastern Cape, where farm workers gathered for cattle auctions, pooled money to buy together, and turned the gathering itself into a regular social occasion. The saving and the socialising were never separate, and still are not.',
      'Through the twentieth century, with Black South Africans largely excluded from formal banking, stokvels became a parallel financial system rather than a supplement to one. That history is why they are far more organised than most rotating savings traditions: they had to carry real weight.',
    ],
    howItRuns: [
      'Most stokvels have a written constitution. It names the office bearers, sets the monthly amount, states the penalty for paying late, and lays down how a member leaves or is removed. Meetings are minuted. Many clubs hold a bank account in the club\'s name with multiple signatories.',
      'The classic rotating form pays out to one member each month. But the model has branched more than any other tradition here. Grocery stokvels save all year and buy food in bulk before December. Burial societies pay out on a death, covering funeral costs that would otherwise fall on one household. Property and equipment clubs pool towards something the group buys together.',
      'Payout order is whatever the constitution says. Strict rotation is most common; some clubs allow a member to bring their turn forward for a documented emergency, decided by vote rather than by bidding.',
    ],
    distinctive: [
      'Stokvels are the most formally organised rotating savings tradition on this list, and the only one with a national representative body: the National Stokvels Association of South Africa. Clubs meeting its conditions operate under an exemption from the Banks Act, which lets them take members\' contributions without being a bank — an accommodation no other tradition here has.',
      'They are also the largest by money moved. Estimates of the sector run to tens of billions of rand a year across millions of members, and the major South African banks and retailers market products specifically at stokvel clubs. This is not a marginal practice; it is a recognised part of the financial landscape.',
    ],
    diaspora: [
      'South Africans abroad — in the United Kingdom, Australia and across the region — keep stokvels going, often to fund trips home or to support family. Related practices run under their own names across Southern Africa: motshelo in Botswana, chilemba in Zambia and Malawi, xitique in Mozambique.',
      'The constitutional habit travels well: a diaspora stokvel usually still has written rules and named office bearers. What breaks is the meeting. The rules assume everyone is in the room once a month, and once the group is spread across time zones the treasurer\'s notebook becomes the only record anyone has.',
    ],
    related: ['chama', 'equb', '/learn/blockchain-rosca', 'esusu'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'chama',
    term: 'Chama',
    pronunciation: 'CHAH-mah',
    alsoKnownAs: ['Merry-go-round', 'Table banking group', 'Self-help group'],
    region: 'Kenya, with related groups across East Africa',
    etymology:
      'Swahili for a group, body or association — the same word used for a political party or any organised body.',
    shortDefinition:
      'A Kenyan savings group, often women-led, that rotates a pooled amount between members and frequently grows into a group that buys assets together.',
    typicalSize: '10 to 30 members',
    typicalCycle: 'Weekly or monthly, tied to a standing meeting',
    orderingRule: 'Rotation agreed by the group, often revisited each cycle',
    origin: [
      'Chamas grew out of long-standing Kenyan traditions of collective labour and mutual aid, where neighbours took turns working each other\'s land or rebuilding each other\'s houses. Applying the same turn-taking logic to money was a short step, and the practice spread widely through the second half of the twentieth century.',
      'The rotating form is often called a "merry-go-round" in Kenyan English — a plain description of a pot that comes around to each member in turn. Many chamas are made up entirely of women, and for a great many members the chama, not a bank, is where financial life actually happens.',
    ],
    howItRuns: [
      'A chama meets on a fixed schedule, and the meeting is not optional decoration — it is where contributions are handed over, where the record is read out, and where decisions get made. Members contribute an agreed amount, one member takes the pool, and the group works through the rotation.',
      'Many chamas run a second pool alongside the rotating one, built up rather than paid out. This is where "table banking" comes in: money is stacked on the table at the meeting and lent out to members on the spot, repaid over following meetings. A chama can be running the rotation and the lending pool at the same time.',
      'Groups that want legal standing register with the state as a self-help group or a co-operative, which lets them hold a bank account and sign contracts in the group\'s name. Plenty never register and run on trust and the minute book.',
    ],
    distinctive: [
      'The chama is the tradition most likely to outgrow the rotating pot. A group that starts by passing a small sum around often ends up buying land together, acquiring equipment, or running a business as a group, with the rotation continuing underneath as the mechanism that keeps everyone contributing.',
      'That trajectory has made chamas a recognised economic force in Kenya rather than a private arrangement. Banks market group accounts at them, and the practice is bound up with the country\'s wider culture of "harambee" — pulling together to fund something no one member could fund alone.',
    ],
    diaspora: [
      'Kenyan communities in the United Kingdom, the United States and the Gulf run chamas, commonly to fund a house or a business back home. Diaspora chamas often carry larger amounts than local ones, which raises the stakes on record-keeping considerably.',
      'Related groups run across the region under their own names — kikoba in Tanzania, and the various Ugandan and Rwandan village savings groups — sharing the same rotate-and-lend structure.',
    ],
    related: ['stokvel', 'equb', 'esusu', '/learn/blockchain-rosca'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'esusu',
    term: 'Esusu',
    pronunciation: 'eh-SOO-soo',
    alsoKnownAs: ['Isusu', 'Osusu', 'Susu', 'Etoto', 'Adashi'],
    region: 'Nigeria — Yoruba and Igbo communities — and across West Africa',
    etymology:
      'Yoruba. Widely held to be the root of the Caribbean "susu" and "sou-sou", carried across the Atlantic during the slave trade.',
    shortDefinition:
      'A Yoruba rotating savings circle, and the probable ancestor of the Caribbean susu — members contribute on a set schedule and take the pool in turn.',
    typicalSize: '10 to 30 members',
    typicalCycle: 'Weekly or monthly',
    orderingRule: 'Fixed at the outset by lot or by seniority within the group',
    origin: [
      'Esusu is one of the oldest rotating savings practices with a continuous documented history, recorded among the Yoruba of what is now south-western Nigeria long before any colonial banking system reached the region. Anthropologists studying it in the twentieth century found an institution already fully formed and deeply embedded.',
      'Its wider significance is what happened to the word. Enslaved West Africans carried the practice across the Atlantic, and it survives in the Caribbean as susu, sou-sou and — in Jamaica — Partner. Esusu is one of the clearest cases of a functioning economic institution surviving the Middle Passage intact.',
    ],
    howItRuns: [
      'Members agree an amount and a rhythm, most often weekly or monthly, and each contributes the same sum each round. The full pool goes to one member, and the cycle continues until everyone has taken a turn. Order is normally fixed at the start, by drawing lots or by seniority.',
      'A head — the "olori esusu" in Yoruba — collects, keeps the record and takes responsibility if a member falls short. The role carries genuine standing, and it is not a job for someone the group does not already trust with their reputation.',
      'The Igbo variant, isusu, works the same way. Across northern Nigeria the Hausa "adashi" fills the same role. The mechanics travel; the name changes with the language.',
    ],
    distinctive: [
      'Esusu matters as much for its lineage as its mechanics. Tracing esusu to susu to sou-sou to Partner connects West African, Caribbean and Black American savings practice into a single continuous tradition — which is why the Caribbean and West African pages here belong together rather than apart.',
      'In practice, the Nigerian form is also strongly tied to market traders. Esusu groups among traders in the same market let a member restock in bulk on a scale their daily takings would never reach, with contributions collected on the spot where everyone already sees each other every day.',
    ],
    diaspora: [
      'Nigerian communities in the United Kingdom, the United States and Canada run esusu widely, and it is a common way to raise a deposit for a house, cover school fees, or send a lump sum home. Groups are frequently drawn from a single hometown association, so the social ties are as strong abroad as at home.',
      'The Caribbean descendants of the same practice are covered separately on the susu page, which goes into the Jamaican Partner system and the West Indian collector tradition in more detail.',
    ],
    related: ['/learn/sou-sou-crypto', 'ajo', 'chama', '/learn/what-is-njangi'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'paluwagan',
    term: 'Paluwagan',
    pronunciation: 'pah-loo-WAH-gan',
    alsoKnownAs: ['Palowagan', 'Hulugan', 'Ambagan'],
    region: 'The Philippines, and Filipino communities worldwide',
    etymology:
      'Tagalog, from the root "luwag" — to loosen or ease. A paluwagan is literally a way of easing things.',
    shortDefinition:
      'A Filipino rotating savings circle, most often run inside a workplace, in which colleagues contribute each payday and take the pool in turn.',
    typicalSize: '5 to 20 members',
    typicalCycle: 'Every payday — usually twice a month in the Philippines',
    orderingRule: 'Drawn by lot at the start, though members trade positions by agreement',
    origin: [
      'The paluwagan is bound up with how Filipino workplaces pay. With most salaries arriving twice a month, on the fifteenth and the thirtieth, the paluwagan attaches itself to that rhythm and takes its contribution the moment the money lands.',
      'It runs in offices, factories, schools, hospitals and among jeepney drivers, and it is common enough that a new employee is likely to be invited into one within weeks. The name says what it is for: easing a tight month.',
    ],
    howItRuns: [
      'Someone volunteers to organise — very often an office administrator or someone in payroll, since the mechanics are simple and the position needs to be trusted. Members agree the amount and a number of rounds matching the number of members, and positions are drawn by lot.',
      'On each payday everyone hands over the same amount and one member takes the whole pool. Members swap positions between themselves when circumstances change, which is normal and usually settled in a group chat rather than by any formal process.',
      'Because the group is a workplace, enforcement barely needs discussing. Everyone sees each other daily, and in some arrangements the organiser collects at the same time as payroll. Defaulting is socially expensive in a way it is not among neighbours who can simply stop answering the door.',
    ],
    distinctive: [
      'Paluwagan is the most workplace-native tradition here. Where a stokvel or a chama is built around a community meeting, and a tanda around a family or neighbourhood, the paluwagan assumes a shared employer and a shared pay date, and its whole structure follows from that.',
      'It is also the tradition most likely to be timed around a specific annual event. Christmas paluwagans are deliberately arranged so the final payouts land in December, and groups form in the middle of the year specifically so members have a lump sum ready for the season.',
    ],
    diaspora: [
      'Overseas Filipino workers run paluwagan extensively — among nurses in the United States and the United Kingdom, domestic workers in Hong Kong and Singapore, and construction and service workers across the Gulf. For many, it is how a monthly wage abroad becomes a sum large enough to be worth sending home.',
      'These are the circles most exposed to distance. Members are frequently in three or four countries, contributions arrive through remittance services with their own fees and delays, and the organiser is reconciling several currencies from memory. It is a structure that assumed everyone shared a payday, now stretched across the world.',
    ],
    related: ['hui', 'arisan', 'tanda', '/learn/blockchain-rosca'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'hui',
    term: 'Hui',
    pronunciation: 'hway',
    alsoKnownAs: ['Biao hui', 'Yao hui', 'Hụi', 'Wui', 'Gongsi hui'],
    region: 'China and Taiwan, Vietnam, and Chinese communities worldwide',
    etymology:
      'From the Chinese 會 (huì) — an association or gathering. The Vietnamese "hụi" is the same institution under a Vietnamese spelling.',
    shortDefinition:
      'A Chinese rotating savings association, in bidding and lottery forms, historically central to financing immigrant businesses abroad.',
    typicalSize: '10 to 30 members',
    typicalCycle: 'Monthly',
    orderingRule: 'Either drawn by lot, or bid for — the two forms are named separately',
    origin: [
      'The hui is among the oldest recorded rotating savings institutions anywhere, described in Chinese sources going back many centuries. It predates modern banking in the region by a very long way and, for most of its history, was simply how ordinary people assembled a usable sum of money.',
      'It exists in two clearly named forms. The lottery hui draws for position. The bidding hui — biao hui — auctions the pool, in a mechanism close to the Indian chit fund, developed independently on the other side of the continent.',
    ],
    howItRuns: [
      'An organiser assembles members, sets the amount and the number of rounds, and takes the first pool as the fee for organising and for standing behind the group. That opening claim is conventional and understood by everyone joining.',
      'In the lottery form, each subsequent round draws for who takes the pool. In the bidding form, members who want it early state what they will give up, and the one who offers to take the least gets it — with the shortfall spread among the members still waiting. Members who have already taken their turn pay the full amount from then on.',
      'The organiser carries real liability. If a member who has already taken the pool stops contributing, the organiser is expected to make up the difference, which is why the role goes to someone with both standing and means.',
    ],
    distinctive: [
      'The hui\'s bidding form arrived at the same answer as the Indian chit fund — auction the turn, share the discount — with no apparent contact between the two traditions. When two societies independently invent the same mechanism, it is usually because the underlying problem is sharp and the solution is close to forced.',
      'Its other distinction is historical weight. Chinese immigrant business in nineteenth and twentieth-century America was financed substantially through hui, at a time when Chinese immigrants were largely refused bank credit outright. A great many laundries, restaurants and shops opened on a hui pool rather than a loan.',
    ],
    diaspora: [
      'Hui remain active in Chinese communities across South East Asia, North America, Australia and Europe, and the Vietnamese hụi is widespread in Vietnamese communities in the United States, France and Australia. Both continue to be used for business capital as much as for household needs.',
      'The organiser\'s personal liability is what makes distance dangerous here. Where other traditions spread a failure across the group, the hui concentrates it on one person, and that person is increasingly tracking members across several countries with no shared record of who has paid.',
    ],
    related: ['chit-fund', 'kye', 'arisan', 'paluwagan'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'arisan',
    term: 'Arisan',
    pronunciation: 'ah-ree-SAHN',
    alsoKnownAs: ['Arisan keluarga', 'Arisan ibu-ibu'],
    region: 'Indonesia, and Indonesian communities abroad',
    etymology:
      'Indonesian, from the root "aris" — the sense of taking something in turn or by rotation.',
    shortDefinition:
      'An Indonesian rotating savings gathering where names are drawn from a shaken container, and the social meeting matters as much as the money.',
    typicalSize: '10 to 25 members',
    typicalCycle: 'Monthly, structured around a hosted gathering',
    orderingRule: 'Drawn live at each meeting — names rolled up and shaken from a container',
    origin: [
      'The arisan is a fixture of Indonesian social life, particularly among women, and particularly in urban neighbourhoods and extended families. Groups form among relatives, neighbours, colleagues, mosque congregations and school parents, and many run for years.',
      'It is genuinely difficult to describe the arisan as a purely financial arrangement, because participants generally do not experience it that way. The gathering is the point at least as much as the pool is.',
    ],
    howItRuns: [
      'Members meet on a fixed schedule, usually monthly, at a member\'s home — frequently the home of whoever won last time, who hosts and provides food. Everyone brings the agreed contribution.',
      'The draw happens live and in front of everyone. Names are written on slips, rolled up, put into a container, and the container is shaken until one falls out. That member takes the pool, and their name is removed from the container so nobody wins twice before everyone has won once.',
      'The cycle runs until the container is empty and every member has taken a turn. Then the group typically decides on the spot to start again, often with the same people.',
    ],
    distinctive: [
      'The arisan is the only tradition here where the ordering is deliberately decided in public, in real time, by a physical act everyone watches. That is not incidental. The shaken container makes fairness visible in a way that a list drawn up in advance cannot, and it removes any question of the organiser having arranged the order.',
      'It is also the most explicitly social. The rotating host, the shared food, the fixed monthly gathering — these are load-bearing parts of the institution, not decoration around it. An arisan that stopped meeting and just moved money would not really be an arisan.',
    ],
    diaspora: [
      'Indonesian communities in the Netherlands, Australia, Singapore, Malaysia and the United States run arisan, often through student associations, mosque communities or embassy-adjacent social groups. Abroad they carry an additional weight as one of the few reliable reasons a dispersed community gathers regularly.',
      'Distance hits the arisan harder than most, precisely because the meeting is the institution. A diaspora arisan that moves to a video call keeps the money working but loses the shaken container and the shared meal, which is much of what the members were actually there for.',
    ],
    related: ['paluwagan', 'hui', 'gameya', '/learn/blockchain-rosca'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'equb',
    term: 'Equb',
    pronunciation: 'eh-KOOB',
    alsoKnownAs: ['Iqub', 'Ekub', 'Eqqub'],
    region: 'Ethiopia and Eritrea, and Habesha communities abroad',
    etymology:
      'Amharic. Distinct from "idir", the Ethiopian burial and mutual-aid society, which is a different institution and does not rotate.',
    shortDefinition:
      'An Ethiopian rotating savings association, drawn by lot, used heavily by traders and small businesses to assemble working capital.',
    typicalSize: '10 to 50 members, sometimes far more in market-based groups',
    typicalCycle: 'Weekly or monthly',
    orderingRule: 'Drawn by lot at each round, among members who have not yet taken a turn',
    origin: [
      'The equb is a long-standing Ethiopian institution and remains one of the most widely used financial arrangements in the country. It runs among neighbours, among colleagues, and — most consequentially — among traders in the same market.',
      'It is worth separating from the idir, which foreigners often conflate with it. An idir is a mutual-aid society that pays out when a member suffers a death or a disaster; contributions are not returned in rotation. An equb rotates. The two frequently coexist among the same people, doing different jobs.',
    ],
    howItRuns: [
      'Members agree an amount and a schedule and appoint a committee — usually a chairperson, a treasurer and a judge or arbitrator, the last specifically to settle disputes. Larger equbs keep written records and may require a guarantor for each member.',
      'At each round contributions are collected and a draw is held among the members who have not yet had their turn. The name drawn takes the whole pool. Everyone keeps contributing until the cycle completes, including those who have already been paid.',
      'Larger market equbs can move substantial sums and are run with corresponding seriousness: signed agreements, guarantors, and a genuine expectation that the arbitrator will be used if needed.',
    ],
    distinctive: [
      'The equb is the tradition most explicitly used as business capital rather than household smoothing. For a great many Ethiopian traders it is the primary source of working capital — the way stock gets bought, a stall gets expanded, or a vehicle gets replaced — with formal lending playing a secondary role at most.',
      'It also has the most developed dispute machinery. Appointing an arbitrator at the outset, before any dispute exists, is a structural choice most of these traditions do not make; they rely on the organiser\'s standing instead. The equb assumes conflict is possible and builds for it.',
    ],
    diaspora: [
      'Ethiopian and Eritrean communities in the United States — Washington DC especially — as well as in Israel, Sweden and the Gulf run equb actively. They fund business startups, property purchases, and support sent to family at home.',
      'Diaspora equbs often keep the committee structure, including the arbitrator, which travels better than a monthly meeting does. The record is still usually one treasurer\'s notebook, and that is the part that struggles once members are in several countries.',
    ],
    related: ['chama', 'stokvel', 'esusu', '/learn/blockchain-rosca'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'ajo',
    term: 'Ajo',
    pronunciation: 'AH-jaw',
    alsoKnownAs: ['Ajo alajo', 'Adashi', 'Daily contribution'],
    region: 'Nigeria, particularly among Yoruba traders and market communities',
    etymology:
      'Yoruba, meaning a contribution or a pooling. The collector who runs it is the "alajo".',
    shortDefinition:
      'A Nigerian daily-contribution practice in which a collector visits traders each day and returns the accumulated sum at the end of the period.',
    typicalSize: 'Varies — a single collector may serve dozens or hundreds of traders',
    typicalCycle: 'Daily collection, with a payout at the end of the month or agreed period',
    orderingRule: 'Not a rotation in the collector model — each contributor gets their own money back',
    origin: [
      'Ajo grew up in Nigerian markets, where traders take small amounts of cash all day and have nowhere secure or disciplined to put it. The alajo — the collector — walks a fixed route each day, takes whatever each trader can spare, and marks it on a card.',
      'The best-known figure in this tradition is the itinerant collector with a ledger card, a role that has existed in Nigerian markets for generations and is still very much alive alongside mobile money.',
    ],
    howItRuns: [
      'A trader agrees a daily amount with the collector. The collector comes by every day, takes the money, and marks the card — one square per day. At the end of the agreed period, usually a month, the collector returns the total.',
      'The collector keeps roughly one day\'s contribution out of the period as their fee. The trader therefore gets back slightly less than they put in, and this is entirely explicit: the service being paid for is discipline and safekeeping, not growth.',
      'The word ajo is also used for straightforward rotating circles among Yoruba speakers, in which case it functions like esusu — everyone contributes and each takes the pool in turn. Which sense is meant depends on the group and the context.',
    ],
    distinctive: [
      'In its collector form, ajo is the one entry here that is not really a rotating circle. Nobody takes anyone else\'s money; each contributor gets their own back, minus a fee. It is included because it sits alongside esusu in the same markets, among the same people, and the two are often discussed together and confused by outsiders.',
      'That contrast is useful for understanding what a rotating circle actually provides. Ajo gives you your own money back later. A rotating circle gives you everyone\'s money now and your obligation to keep paying afterwards. The second is what lets a member act before they have saved enough alone — and it is the only one that requires the group to trust each other.',
    ],
    diaspora: [
      'The collector model is tied to physical markets and does not travel especially well, but Nigerian communities abroad continue to use ajo in its rotating sense, alongside esusu, for house deposits, school fees and support sent home.',
      'The Hausa "adashi" in northern Nigeria covers similar ground, and rotating groups under either name are common in Nigerian communities in the United Kingdom, the United States and Canada.',
    ],
    related: ['esusu', '/learn/sou-sou-crypto', '/learn/what-is-njangi', 'chama'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'cundina',
    term: 'Cundina',
    pronunciation: 'koon-DEE-nah',
    alsoKnownAs: ['Tanda', 'Quiniela', 'Rueda'],
    region: 'Northern Mexico and the border states, and Mexican-American communities',
    etymology:
      'Spanish, regional to northern Mexico. Where central and southern Mexico say tanda, the north says cundina.',
    shortDefinition:
      'The northern Mexican name for a rotating savings circle — mechanically a tanda, with its own regional vocabulary and border-town character.',
    typicalSize: '10 to 20 members',
    typicalCycle: 'Weekly or fortnightly, tied to payday',
    orderingRule: 'Numbers assigned at the start, by draw or by agreement',
    origin: [
      'Cundina is what a rotating savings circle is called in Baja California, Sonora, Chihuahua and the rest of northern Mexico. Structurally it is the same institution as the tanda; the difference is regional vocabulary, and Mexicans will often tell you which part of the country someone is from by which word they use.',
      'It is worth its own entry precisely because people search for the word they grew up with. Someone looking for help running a cundina is not necessarily going to find it under "tanda".',
    ],
    howItRuns: [
      'An organiser gathers members, sets a fixed amount and a schedule usually matched to payday, and assigns numbers. Each round every member pays in and the member whose number has come up takes the whole pool.',
      'The organiser collects, keeps the list, and is expected to cover any shortfall rather than let a round fail. As with the tanda, that expectation is what makes the role a matter of standing rather than administration.',
      'Cundinas are common in maquiladora plants along the border, where large workforces are paid on the same day and a group forms easily within a shift or a department.',
    ],
    distinctive: [
      'The cundina\'s distinguishing feature is geographic rather than mechanical: it operates in a border economy where members frequently hold money on both sides of the line. A group can have members paid in pesos and members paid in dollars, sometimes the same member in different weeks.',
      'That makes it the tradition where currency and cross-border transfer show up as an everyday problem rather than a diaspora edge case. The organiser is reconciling two currencies as a matter of routine.',
    ],
    diaspora: [
      'Cundinas run throughout Mexican-American communities in California, Arizona and Texas, and often span the border directly — some members in Tijuana, others in San Diego, in what is really a single community with a fence through it.',
      'As with tandas, community organisations in the United States have run formalised versions so that participation can be documented and used to establish a credit record for members who otherwise have none.',
    ],
    related: ['tanda', 'pandero', '/learn/blockchain-rosca', 'gameya'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'gameya',
    term: 'Gameya',
    pronunciation: 'gam-EE-yah',
    alsoKnownAs: ["Gam'iyya", 'Jam’iyya', 'Gamaeya', 'Sanduq'],
    region: 'Egypt, with related practices across the Arab world',
    etymology:
      'From the Arabic جمعية (jam’iyya) — an association or society. The Egyptian pronunciation gives the "g".',
    shortDefinition:
      'An Egyptian rotating savings circle, overwhelmingly workplace- and family-based, and one of the most widely practised in the Arab world.',
    typicalSize: '10 to 20 members',
    typicalCycle: 'Monthly, on payday',
    orderingRule: 'Agreed at the start, with early positions given to those with a known need',
    origin: [
      'The gameya is deeply ordinary in Egypt — so common in offices, government ministries, schools and extended families that it barely registers as a distinct financial practice. It is simply what people do when they need a lump sum and a salary that does not otherwise produce one.',
      'Its prevalence is partly explained by religious considerations: because a gameya involves no charge for early access and no payment for waiting, members take out exactly what they put in, which makes it straightforwardly acceptable under Islamic finance principles where conventional borrowing is not.',
    ],
    howItRuns: [
      'A group of colleagues or relatives agrees a monthly amount and a number of months matching the number of members. Contributions are handed over on payday, and one member takes the whole pool each month.',
      'The order is settled by discussion more often than by lot. Someone with a wedding to pay for, a term\'s fees due, or a medical bill will say so, and the group will generally put them early. Fairness here is a negotiated judgement about need rather than a procedural rule.',
      'One member holds the role of organiser, collecting and tracking. In workplace gameyas this is often someone in an administrative or payroll position, for the same practical reasons as in a Filipino paluwagan.',
    ],
    distinctive: [
      'The gameya is the clearest example of a rotating circle chosen partly on religious grounds. Because nobody pays more than they receive and nobody receives more than they pay, it avoids the objection that applies to conventional lending — which is a substantial part of why it is so widespread across the Arab world rather than a niche practice.',
      'It is also the tradition where the ordering is most openly needs-based. An arisan draws lots, a chit fund runs an auction, an equb draws by lot — a gameya usually just talks it through, which works because the members are colleagues or relatives who already know each other\'s circumstances.',
    ],
    diaspora: [
      'Egyptian and wider Arab communities in the Gulf, Europe and North America run gameyas, frequently among colleagues who migrated together. Related practices exist across the region under their own names, including the Sudanese and Levantine "sanduq" — literally, the box.',
      'The needs-based ordering is what suffers most at a distance. Deciding who goes first because someone spoke up at the office is hard to reproduce when the group has not been in the same room for a year.',
    ],
    related: ['equb', 'arisan', 'paluwagan', '/learn/blockchain-rosca'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'kye',
    term: 'Kye',
    pronunciation: 'keh',
    alsoKnownAs: ['Gye', 'Ke', 'Kyeh'],
    region: 'Korea, and Korean communities abroad',
    etymology:
      'From the Korean 계 (gye) — a bond, a contract, or an association. One of the oldest surviving Korean social institutions.',
    shortDefinition:
      'A Korean rotating savings association with roots in village mutual-aid societies, historically central to financing Korean-American small business.',
    typicalSize: '10 to 20 members',
    typicalCycle: 'Monthly',
    orderingRule: 'Fixed by agreement, or bid for in the older commercial forms',
    origin: [
      'The kye is very old. Its ancestors are the village mutual-aid societies of premodern Korea, which organised collective labour, funerals, weddings and shared expenses long before money-based rotation became the dominant form. The word itself carries the sense of a bond or contract rather than a scheme.',
      'It survived Korea\'s rapid twentieth-century industrialisation and the arrival of a full banking system, which says something about what it provides that a bank does not: the kye is a social obligation among people who know each other, and it does not ask for a credit file.',
    ],
    howItRuns: [
      'Members — often relatives, church congregants, or people from the same home region — agree a monthly amount and a number of rounds. Each month everyone contributes and one member takes the whole pool.',
      'Order is usually agreed at the outset. Larger and more commercial kye historically used bidding, in the same shape as the Chinese hui and the Indian chit fund, with early takers accepting less. Smaller family and church kye generally do not bother, and simply rotate.',
      'The organiser carries the group\'s trust and, in the larger forms, real financial exposure if a member who has already taken the pool stops paying.',
    ],
    distinctive: [
      'The kye is unusually tied to a specific institution abroad: the Korean church. In Korean-American communities the congregation is frequently the pool of members, which supplies both the social ties and the enforcement — defaulting on people you will see at church every Sunday is a different proposition from defaulting on strangers.',
      'Its documented economic effect is also unusually large. Korean-American small business in the second half of the twentieth century — the corner stores, dry cleaners and grocers that became a recognised feature of American cities — was financed substantially through kye, at a scale that made it a subject of serious economic study rather than a cultural footnote.',
    ],
    diaspora: [
      'Kye remain active in Korean communities in the United States, Canada, Japan, Australia and Brazil, typically for business capital, property deposits, or a child\'s education.',
      'They are also, historically, the tradition with the best-documented failures. Large commercial kye in both Korea and the diaspora have collapsed when an organiser absconded or a chain of defaults ran through the group — a reminder that a rotating circle concentrates trust in a way that works beautifully until it does not, and that the record of who has paid is the thing worth protecting.',
    ],
    related: ['hui', 'chit-fund', 'pandero', '/learn/blockchain-rosca'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },

  {
    slug: 'pandero',
    term: 'Pandero',
    pronunciation: 'pan-DEH-ro',
    alsoKnownAs: ['Junta', 'Quiniela', 'Pandereta'],
    region: 'Peru, with related practices across the Andes',
    etymology:
      'Spanish for a tambourine — the instrument passed hand to hand around a circle, which is the image the name borrows.',
    shortDefinition:
      'A Peruvian rotating savings circle, existing both as an informal junta among friends and as a regulated commercial product.',
    typicalSize: '10 to 40 members, larger in the commercial form',
    typicalCycle: 'Monthly',
    orderingRule: 'Informal juntas fix the order; commercial panderos draw or auction each month',
    origin: [
      'In Peru the same practice runs under two names at two levels of formality. The junta is the informal version — friends, relatives or colleagues passing a pool around, indistinguishable in structure from a Mexican tanda. The pandero is the commercial version, run by registered companies.',
      'The tambourine image is apt: an object passed hand to hand around a circle, each person holding it in turn.',
    ],
    howItRuns: [
      'An informal junta works exactly as you would expect. Members agree an amount and a schedule, the order is set at the start, and each round one member takes the pool. An organiser collects and keeps the list.',
      'The commercial pandero is a different animal. Companies run large groups explicitly aimed at a purchase — a vehicle or a property — over long terms, with contracts, and with each month\'s recipient decided by a draw or an auction among the members. These firms are supervised by the Peruvian securities regulator.',
      'The two coexist. Many Peruvians use an informal junta among people they know and would consider a commercial pandero only for something large enough to need a contract behind it.',
    ],
    distinctive: [
      'Peru is the clearest case of a rotating savings tradition existing simultaneously as a purely social arrangement and as a supervised commercial product, with the same underlying mechanism and different names for each. Most countries have one or the other; Peru has both, in the open, side by side.',
      'The commercial pandero is also unusual in being aimed at a specific object. Rather than pooling money for whatever a member needs, groups are formed around buying vehicles or homes, and the payout is applied to that purchase — closer to a purchasing consortium than a general savings circle.',
    ],
    diaspora: [
      'Peruvian communities in Chile, Spain, the United States, Argentina and Japan run juntas, usually the informal kind, among people from the same city or region back home.',
      'Related practices run across the Andes and the wider region — pasanaku in Bolivia, cadena and vaquita in Colombia and Venezuela, and the ubiquitous quiniela. The mechanism is constant; the name changes at every border.',
    ],
    regulatoryNote:
      'Commercial pandero companies in Peru are supervised by the Superintendencia del Mercado de Valores. Njangi On-Chain is coordination software for groups running their own circle. It is not a pandero company, does not operate a supervised fund, and never holds or directs members\' money.',
    related: ['tanda', 'cundina', 'chit-fund', '/learn/blockchain-rosca'],
    published: '2026-08-02',
    modified: '2026-08-02',
  },
];

export function termBySlug(slug: string): RoscaTerm | undefined {
  return ROSCA_TERMS.find((term) => term.slug === slug);
}

/** Resolve a `related` value, which is either a slug in this file or a pillar path. */
export function relatedLink(ref: string): { href: string; label: string } {
  if (ref.startsWith('/')) {
    const pillar: Record<string, string> = {
      '/learn/what-is-njangi': 'Njangi',
      '/learn/blockchain-rosca': 'ROSCA',
      '/learn/tontine-blockchain': 'Tontine',
      '/learn/sou-sou-crypto': 'Susu',
    };
    return { href: ref, label: pillar[ref] ?? ref };
  }
  const term = termBySlug(ref);
  return { href: `/learn/${ref}`, label: term?.term ?? ref };
}
