import Link from 'next/link';
import { useState } from 'react';
import { Seo } from '../../components/Seo';
import { breadcrumbs } from '../../lib/structured-data';
import { Breadcrumbs, MarketingShell } from '../../components/marketing/ArticleLayout';
import { keepBrand } from '../../components/marketing/PageBlocks';
import { ChevronLink, focusRing, goldButtonClass, quietButtonClass } from '../../components/landing/ui';

type Post = {
  id: string;
  title: string;
  excerpt: string;
  category: string;
  readTime: string;
  /** ISO date (YYYY-MM-DD). */
  publishDate: string;
  author: string;
  tags: string[];
  href: string;
  available: boolean;
};

// `available` marks which of these have a page behind them. Four did not,
// and the index linked to all five regardless — five internal links, four
// of them straight to a 404. Unavailable posts render as a tile with no
// link rather than being removed, so a planned slate stays visible.
const BLOG_POSTS: Post[] = [
  {
    id: 'traditional-savings-circles-vs-on-chain',
    title: 'Traditional Savings Circles vs. On-Chain: What Actually Changes',
    excerpt:
      'A side-by-side on how a njangi, tontine or susu works traditionally, what changes when the record is shared, and what deliberately does not.',
    category: 'Technology',
    readTime: '8 min read',
    publishDate: '2025-06-05',
    author: 'Njangi On-Chain',
    tags: ['rosca', 'njangi', 'tontine', 'susu'],
    href: '/blog/traditional-savings-circles-vs-on-chain',
    available: true,
  },
  {
    id: 'african-diaspora-remittances',
    title: "Sending Money Home Isn't the Same as Belonging",
    excerpt:
      'The World Bank puts the average cost of sending $200 to Sub-Saharan Africa at 7.9%. A savings circle does not change that number. What it changes is whether the person sending is a member or only a source of funds.',
    category: 'Diaspora',
    readTime: '10 min read',
    publishDate: '2026-08-28',
    author: 'Njangi On-Chain',
    tags: ['diaspora', 'remittances', 'africa'],
    href: '/blog/african-diaspora-remittances',
    available: true,
  },
  {
    id: 'women-led-savings-circles-africa',
    title: 'Women-Led Savings Circles: Who Actually Runs the Money',
    excerpt:
      'Across njangis, chamas, stokvels and tontines, the person holding the money is very often a woman. What that role involves, what it costs her, and what a shared record changes.',
    category: 'Social Impact',
    readTime: '9 min read',
    publishDate: '2026-08-24',
    author: 'Njangi On-Chain',
    tags: ['women', 'leadership', 'social-impact'],
    href: '/blog/women-led-savings-circles-africa',
    available: true,
  },
  {
    id: 'how-regulators-treat-savings-circles',
    title: 'How Regulators Treat Community Savings Circles',
    excerpt:
      'A country-by-country look at how rotating savings groups are regulated, and what it means for a circle that spans borders.',
    category: 'Regulation',
    readTime: '11 min read',
    publishDate: '2026-08-28',
    author: 'Njangi On-Chain',
    tags: ['regulation', 'compliance', 'legal'],
    href: '/blog/how-regulators-treat-savings-circles',
    available: true,
  },
];

// Newest first, so "Latest Post" is the latest. The array above was in
// authoring order, which put a 2025 post in the feature slot. Array sort is
// stable, so same-day posts keep their authoring order.
const POSTS_BY_DATE = [...BLOG_POSTS].sort((a, b) => b.publishDate.localeCompare(a.publishDate));

const CATEGORIES = ['all', 'Technology', 'Diaspora', 'Social Impact', 'Regulation'];

const LEARN_LINKS = [
  { href: '/learn/what-is-njangi', title: 'What is Njangi?', body: 'Learn about Cameroon’s traditional savings circles.' },
  { href: '/learn/rosca', title: 'What is a ROSCA?', body: 'Discover the future of community savings.' },
  { href: '/learn/tontine', title: 'What is a Tontine?', body: 'The rotating savings circle across West and Central Africa.' },
  { href: '/learn/susu', title: 'What is a Susu?', body: 'Caribbean savings circles go digital.' },
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-08-28" → "28 August 2026". Parsed by hand: `new Date('2026-08-28')`
 *  is UTC midnight, which renders as the 27th anywhere west of Greenwich —
 *  and differently on the server than in the reader's browser. */
function formatDate(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** The feature tile's artwork: a circle of members with one turn lit, the
 *  rotation motif from the landing page. Seeded by the post so the art
 *  changes with the feature. Coordinates are rounded so server and browser
 *  print identical attributes. */
function RotationArt({ seed }: { seed: string }) {
  const seats = 10;
  const radius = 64;
  const turn = 2 + (seed.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % (seats - 3));
  const circumference = 2 * Math.PI * radius;
  return (
    <div aria-hidden className="relative flex min-h-[240px] items-center justify-center overflow-hidden bg-[#0c0c0e] md:min-h-full">
      <div className="absolute inset-0 bg-[radial-gradient(360px_260px_at_50%_52%,rgba(232,176,75,0.18),transparent_70%)]" />
      <svg viewBox="0 0 200 200" className="relative h-[210px] w-[210px] md:h-[260px] md:w-[260px]">
        <circle cx="100" cy="100" r={radius} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
        <circle
          cx="100"
          cy="100"
          r={radius}
          fill="none"
          stroke="#E8B04B"
          strokeOpacity="0.7"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={`${((turn / seats) * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
          transform="rotate(-90 100 100)"
        />
        {Array.from({ length: seats }, (_, i) => {
          const angle = (i / seats) * 2 * Math.PI - Math.PI / 2;
          const lit = i === turn;
          return (
            <circle
              key={i}
              cx={(100 + radius * Math.cos(angle)).toFixed(2)}
              cy={(100 + radius * Math.sin(angle)).toFixed(2)}
              r={lit ? 7 : 4}
              fill={lit ? '#E8B04B' : i < turn ? 'rgba(232,176,75,0.45)' : 'rgba(255,255,255,0.22)'}
            />
          );
        })}
      </svg>
    </div>
  );
}

function ReadMore({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-[15px] text-gold">
      {label}
      <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5 rtl:rotate-180">
        ›
      </span>
    </span>
  );
}

function Published({ post }: { post: Post }) {
  return post.available ? (
    <time dateTime={post.publishDate}>{formatDate(post.publishDate)}</time>
  ) : (
    <>Not yet published</>
  );
}

const tileClass = 'group flex flex-col rounded-[28px] bg-ink-surface transition-colors duration-200';

/** The newest post: artwork beside the headline, excerpt and byline. */
function FeatureTile({ post }: { post: Post }) {
  const body = (
    <>
      <RotationArt seed={post.id} />
      <div className="flex flex-col p-7 sm:p-10 md:py-12">
        <p className="text-[14px] text-mist-3">
          <span className="font-semibold text-gold">{post.category}</span>
          <span aria-hidden className="mx-2 text-mist-4">
            ·
          </span>
          {post.readTime}
        </p>
        <h3 className="type-tile mt-4 text-balance text-mist">{keepBrand(post.title)}</h3>
        <p className="type-body mt-4 flex-1 text-mist-2">{post.excerpt}</p>
        <div className="mt-8 flex items-center justify-between gap-4">
          <span className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[15px] font-semibold text-mist"
            >
              N
            </span>
            <span>
              <span className="block text-[15px] font-semibold tracking-[-0.01em] text-mist">{post.author}</span>
              <span className="block text-[13px] text-mist-3">
                <Published post={post} />
              </span>
            </span>
          </span>
          {post.available ? (
            <ReadMore label="Read More" />
          ) : (
            <span className="text-[13px] font-semibold text-mist-3">Coming soon</span>
          )}
        </div>
      </div>
    </>
  );
  const cls = `${tileClass} mt-8 overflow-hidden md:grid md:grid-cols-[1.05fr_1fr]`;
  return post.available ? (
    <Link href={post.href} className={`${cls} hover:bg-[#1b1b1e] ${focusRing}`}>
      {body}
    </Link>
  ) : (
    <article className={cls}>{body}</article>
  );
}

function PostTile({ post }: { post: Post }) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-4">
        <span className="text-[13px] font-semibold text-gold">{post.category}</span>
        <span className="text-[13px] text-mist-3">{post.readTime}</span>
      </span>
      <h3 className="mt-5 text-[21px] font-semibold leading-snug tracking-[0.011em] text-mist">
        {keepBrand(post.title)}
      </h3>
      <p className="type-caption mt-3 flex-1 text-mist-3">{post.excerpt}</p>
      <span className="mt-7 flex items-center justify-between gap-4">
        <span className="text-[13px] text-mist-3">
          <Published post={post} />
        </span>
        {post.available ? (
          <ReadMore label="Read" />
        ) : (
          <span className="text-[13px] font-semibold text-mist-3">Coming soon</span>
        )}
      </span>
    </>
  );
  return post.available ? (
    <Link href={post.href} className={`${tileClass} p-7 hover:bg-[#1b1b1e] sm:p-8 ${focusRing}`}>
      {body}
    </Link>
  ) : (
    <article className={`${tileClass} p-7 sm:p-8`}>{body}</article>
  );
}

export default function BlogIndexPage() {
  const [activeCategory, setActiveCategory] = useState('all');

  const filteredPosts =
    activeCategory === 'all' ? POSTS_BY_DATE : POSTS_BY_DATE.filter((post) => post.category === activeCategory);
  const [latest, ...rest] = filteredPosts;

  return (
    <>
      <Seo
        title="Writing on Community Savings"
        description="Notes on rotating savings circles — how they work, how diaspora communities run them across borders, and what changes when the ledger is shared."
        path="/blog"
        image={{ url: '/og/blog.png', alt: 'Njangi On-Chain — notes on community savings' }}
        jsonLd={[breadcrumbs([{ name: 'Home', path: '/' }, { name: 'Blog' }])]}
      />

      <MarketingShell legacy={false}>
        {/* ================= HERO ================= */}
        <header className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_460px_at_50%_-12%,rgba(232,176,75,0.10),transparent_64%)]"
          />
          <div className="relative mx-auto max-w-[1100px] px-5 pb-14 pt-8 text-center sm:px-8 md:pb-20 md:pt-12">
            <Breadcrumbs className="flex justify-center" items={[{ label: 'Home', href: '/' }, { label: 'Blog' }]} />
            <h1 className="type-hero mx-auto mt-12 max-w-[14ch] text-balance text-mist">{keepBrand('The Njangi On-Chain Blog')}</h1>
            <p className="type-intro mx-auto mt-6 max-w-[44rem] text-balance text-mist-2">
              Insights, stories, and education about the future of community finance&mdash;from
              traditional savings circles, and what changes when the record is shared.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-8">
              <Link href="/learn" className={goldButtonClass}>
                Educational Resources
              </Link>
              <ChevronLink href="#featured">Latest Posts</ChevronLink>
            </div>
          </div>
        </header>

        {/* ================= FILTER ================= */}
        <div className="px-5 sm:px-8">
          <div
            role="group"
            aria-label="Filter posts by category"
            className="mx-auto flex max-w-[1100px] flex-wrap justify-center gap-2"
          >
            {CATEGORIES.map((category) => {
              const active = activeCategory === category;
              return (
                <button
                  key={category}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setActiveCategory(category)}
                  className={`rounded-full px-4 py-2 text-[14px] transition-colors duration-200 ${
                    active
                      ? 'bg-mist font-medium text-black'
                      : 'bg-white/[0.06] text-mist-2 hover:bg-white/[0.12] hover:text-mist'
                  } ${focusRing}`}
                >
                  {category === 'all' ? 'All Posts' : category}
                </button>
              );
            })}
          </div>
          <p className="sr-only" aria-live="polite">
            {activeCategory === 'all'
              ? `Showing all ${filteredPosts.length} posts`
              : `Showing ${filteredPosts.length} ${filteredPosts.length === 1 ? 'post' : 'posts'} in ${activeCategory}`}
          </p>
        </div>

        {/* ================= POSTS ================= */}
        <section id="featured" aria-label="Posts" className="scroll-mt-[72px] px-5 pb-24 pt-14 sm:px-8 md:pb-32 md:pt-20">
          <div className="mx-auto max-w-[1100px]">
            {latest ? (
              <>
                <h2 className="type-headline text-mist">Latest Post</h2>
                <FeatureTile post={latest} />

                {rest.length > 0 && (
                  <>
                    <h2 className="type-headline mt-20 text-mist md:mt-24">More Articles</h2>
                    <div className="mt-8 grid gap-4 md:grid-cols-2 md:gap-5 lg:grid-cols-3">
                      {rest.map((post) => (
                        <PostTile key={post.id} post={post} />
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="type-intro text-center text-mist-2">No posts in this category yet.</p>
            )}
          </div>
        </section>

        {/* ================= NEW TO SAVINGS CIRCLES ================= */}
        <section className="px-5 pb-24 sm:px-8 md:pb-32">
          <div className="mx-auto max-w-[1100px]">
            <div className="mx-auto max-w-[44rem] text-center">
              <h2 className="type-section text-balance text-mist">New to savings circles?</h2>
              <p className="type-intro mt-5 text-balance text-mist-2">
                Start with our comprehensive educational resources to understand the fundamentals.
              </p>
            </div>
            <ul className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {LEARN_LINKS.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`group flex h-full flex-col rounded-[22px] bg-ink-surface p-6 transition-colors duration-200 hover:bg-[#1b1b1e] ${focusRing}`}
                  >
                    <span className="text-[19px] font-semibold tracking-[0.012em] text-mist">{item.title}</span>
                    <span className="type-caption mt-2 flex-1 text-mist-3">{item.body}</span>
                    <span className="mt-5">
                      <ReadMore label="Read" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ================= STAY UPDATED =================
            This was an email box with a Subscribe button wired to nothing —
            it looked like a sign-up and collected no one. There is no
            newsletter to join, and the only email list we keep is the launch
            waitlist, which the privacy policy scopes to launch news. So the
            section points to where new posts are shared instead. */}
        <section className="px-5 pb-24 sm:px-8 md:pb-32">
          <div className="relative mx-auto max-w-[1100px] overflow-hidden rounded-[32px] bg-ink-surface px-7 py-16 text-center sm:px-12 md:py-20">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-80 max-w-[720px] rounded-full"
              style={{ background: 'radial-gradient(closest-side, rgba(232,176,75,0.16), transparent)' }}
            />
            <h2 className="type-section relative text-balance text-mist">Stay Updated</h2>
            <p className="type-intro relative mx-auto mt-5 max-w-[38rem] text-balance text-mist-2">
              Get the latest on how savings circles work, and educational content, by following
              along where we share every new post.
            </p>
            <div className="relative mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href="https://x.com/njangi_on_chain" className={quietButtonClass}>
                Follow on X
              </a>
              <a href="https://www.instagram.com/njangionchain" className={quietButtonClass}>
                Follow on Instagram
              </a>
            </div>
          </div>
        </section>

        {/* ================= DISCLAIMER ================= */}
        <aside className="px-5 pb-16 sm:px-8">
          <p className="type-fine mx-auto max-w-[44rem] text-center text-mist-3">
            <strong className="font-semibold text-mist-2">Disclaimer:</strong> Content is for
            educational purposes only and does not constitute financial advice. Njangi On-Chain is
            coordination software for savings circles: it never holds your money, never offers an
            investment, and never pays a return. Take part only with an amount your group can commit
            to the schedule.
          </p>
        </aside>
      </MarketingShell>
    </>
  );
}
