// sourced-facts.ts — every external figure quoted on a marketing page.
//
// WHY THIS EXISTS
// The learn pages used to carry invented statistics presented as fact: "1B+
// people use traditional savings circles globally", "$500B+ annual volume",
// "80% women-led savings circles", "$50+ billion mobilized annually", and —
// self-evidently made up — "200+ countries with active savings circle
// traditions", when there are 195 UN member states.
//
// On a page about other people's money that is a real liability, and Google's
// helpful-content guidance treats unverifiable claims as a quality signal
// against the site. Every number here now carries its source, its year, and a
// link the reader can follow. If a claim cannot get an entry in this file, it
// does not go on the page as a number — it gets written as a qualitative
// statement that is true by construction.
//
// RULE FOR ADDING ONE: quote a primary source you have actually read, record
// the year the figure describes (not the year you found it), and link
// somewhere stable. No secondary reporting of a statistic, no "studies show".

export interface SourcedFact {
  /** The figure exactly as it should be displayed. */
  value: string;
  /** What the figure measures. Keep it narrow — do not generalise the source. */
  label: string;
  /** The year the data describes, not the publication year. */
  year: string;
  /** Short attribution shown to the reader. */
  source: string;
  url: string;
}

/**
 * World Bank / KNOMAD, Migration and Development Brief 40, 26 June 2024.
 * Figures verified against the press release text, not a secondary summary.
 */
const BRIEF_40 =
  'https://www.worldbank.org/en/news/press-release/2024/06/26/remittances-slowed-in-2023-expected-to-grow-faster-in-2024';
const BRIEF_40_CITE = 'World Bank Migration and Development Brief 40';

export const REMITTANCES_AFRICA: SourcedFact = {
  value: '$54 billion',
  label: 'Remittances sent to Sub-Saharan Africa',
  year: '2023',
  source: BRIEF_40_CITE,
  url: BRIEF_40,
};

export const REMITTANCES_LAC: SourcedFact = {
  value: '$156 billion',
  label: 'Remittances sent to Latin America and the Caribbean',
  year: '2023',
  source: BRIEF_40_CITE,
  url: BRIEF_40,
};

export const REMITTANCE_COST_AFRICA: SourcedFact = {
  value: '7.9%',
  label: 'Average cost of sending $200 to Sub-Saharan Africa',
  year: '2023',
  source: BRIEF_40_CITE,
  url: BRIEF_40,
};

export const REMITTANCE_COST_GLOBAL: SourcedFact = {
  value: '6.4%',
  label: 'Global average cost of sending $200',
  year: 'Q4 2023',
  source: BRIEF_40_CITE,
  url: BRIEF_40,
};

/**
 * The only direct measurement of savings-club participation I could trace to a
 * primary source. It is old, and the year is shown to the reader for that
 * reason: later Global Findex rounds report formal and semiformal saving but do
 * not publish an equivalent savings-club figure. Do not present this as current.
 */
export const SAVINGS_CLUB_PARTICIPATION: SourcedFact = {
  value: '19% of adults',
  label:
    'Adults in Sub-Saharan Africa who had used a community savings group — 48% of those who saved at all',
  year: '2011',
  source: 'World Bank Global Findex',
  url: 'https://news.gallup.com/poll/154100/one-three-adults-worldwide-saved-money-past-year.aspx',
};
