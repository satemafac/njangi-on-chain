import Link from 'next/link';
import { useState } from 'react';
import { Seo } from '../../components/Seo';
import { breadcrumbs } from '../../lib/structured-data';
import { MarketingShell } from '../../components/marketing/ArticleLayout';

export default function BlogIndexPage() {
  const [activeCategory, setActiveCategory] = useState('all');

  // `available` marks which of these have a page behind them. Four did not,
  // and the index linked to all five regardless — five internal links, four
  // of them straight to a 404. Unavailable posts now render as a card with no
  // link rather than being removed, so the planned slate stays visible.
  const blogPosts = [
    {
      id: 'traditional-savings-vs-blockchain',
      title: "Traditional Savings Circles vs. Blockchain: What's the Real Difference?",
      excerpt: "A comprehensive comparison of how traditional ROSCAs, Njangi, Tontines, and Sou Sou systems stack up against their blockchain counterparts.",
      category: 'Technology',
      readTime: '8 min read',
      publishDate: '2024-01-15',
      author: 'Dr. Amina Hassan',
      tags: ['blockchain', 'traditional-finance', 'comparison'],
      href: '/blog/traditional-savings-vs-blockchain',
      available: true
    },
    {
      id: 'african-diaspora-remittances',
      title: "How African Diaspora Communities Are Revolutionizing Remittances",
      excerpt: "Exploring how blockchain-powered savings circles reduce costs and increase efficiency for the $48 billion African remittance market.",
      category: 'Diaspora',
      readTime: '12 min read',
      publishDate: '2024-01-12',
      author: 'Marcus Thompson',
      tags: ['diaspora', 'remittances', 'africa'],
      href: '/blog/african-diaspora-remittances',
      available: false
    },
    {
      id: 'caribbean-sou-sou-success-stories',
      title: "5 Caribbean Entrepreneurs Who Built Businesses Through Digital Sou Sou",
      excerpt: "Real success stories from the Caribbean showing how blockchain savings circles are funding new businesses and preserving culture.",
      category: 'Success Stories',
      readTime: '10 min read',
      publishDate: '2024-01-10',
      author: 'Maria Rodriguez',
      tags: ['caribbean', 'entrepreneurship', 'success-stories'],
      href: '/blog/caribbean-sou-sou-success-stories',
      available: false
    },
    {
      id: 'women-led-savings-circles-africa',
      title: "Women-Led Savings Circles: The Backbone of African Community Finance",
      excerpt: "How 75% of traditional savings circles across Africa are led by women, and how blockchain technology empowers this leadership.",
      category: 'Social Impact',
      readTime: '9 min read',
      publishDate: '2024-01-05',
      author: 'Grace Mbeki',
      tags: ['women', 'leadership', 'social-impact'],
      href: '/blog/women-led-savings-circles-africa',
      available: false
    },
    {
      id: 'regulatory-landscape-blockchain-savings',
      title: "Navigating the Regulatory Landscape for Blockchain Savings Circles",
      excerpt: "A country-by-country analysis of how regulators are approaching blockchain-based community savings and what it means for users.",
      category: 'Regulation',
      readTime: '11 min read',
      publishDate: '2024-01-03',
      author: 'David Chen',
      tags: ['regulation', 'compliance', 'legal'],
      href: '/blog/regulatory-landscape-blockchain-savings',
      available: false
    }
  ];

  const categories = ['all', 'Technology', 'Diaspora', 'Success Stories', 'DeFi', 'Social Impact', 'Regulation'];

  const filteredPosts = activeCategory === 'all' 
    ? blogPosts 
    : blogPosts.filter(post => post.category === activeCategory);

  const getCategoryColor = (category: string) => {
    const colors = {
      'Technology': 'bg-gold/[0.07] text-gold',
      'Diaspora': 'bg-gold/[0.07] text-gold',
      'Success Stories': 'bg-gold/[0.07] text-gold',
      'DeFi': 'bg-gold/[0.07] text-gold',
      'Social Impact': 'bg-gold/[0.07] text-gold',
      'Regulation': 'bg-ink-surface text-cream'
    };
    return colors[category as keyof typeof colors] || 'bg-ink-surface text-cream';
  };

  return (
    <>
      <Seo
        title="Writing on Community Savings"
        description="Notes on rotating savings circles — how they work, how diaspora communities run them across borders, and what changes when the ledger is shared."
        path="/blog"
        image={{ url: '/og/blog.png', alt: 'Njangi On-Chain — notes on community savings' }}
        jsonLd={[breadcrumbs([{ name: 'Home', path: '/' }, { name: 'Blog' }])]}
      />

      <MarketingShell>
        {/* Navigation */}
        <nav className="bg-ink-surface border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-sand">
              <Link href="/" className="hover:text-gold transition-colors">Home</Link>
              <span>/</span>
              <span className="text-cream font-medium">Blog</span>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="bg-gradient-to-r from-ink-surface to-ink-deep text-cream py-16">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center">
              <h1 className="text-4xl md:text-5xl font-bold mb-6">
                Blockchain Savings Circle Blog
              </h1>
              <p className="text-xl md:text-2xl mb-8 text-cream-muted max-w-4xl mx-auto">
                Insights, stories, and education about the future of community finance—from traditional 
                savings circles to blockchain-powered innovation.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link 
                  href="/learn" 
                  className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors"
                >
                  Educational Resources →
                </Link>
                <Link 
                  href="#featured" 
                  className="border border-gold-deep/55 text-cream px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface hover:text-gold transition-colors"
                >
                  Latest Posts
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Category Filter */}
        <section className="bg-ink-surface border-b">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex flex-wrap gap-3">
              {categories.map((category) => (
                <button
                  key={category}
                  onClick={() => setActiveCategory(category)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeCategory === category
                      ? 'bg-gold/[0.07] text-gold'
                      : 'hover:bg-ink-surface text-sand'
                  }`}
                >
                  {category === 'all' ? 'All Posts' : category}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Featured Posts */}
        <section id="featured" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          {filteredPosts.length > 0 && (
            <>
              {/* Latest Featured Post */}
              <div className="mb-12">
                <h2 className="text-3xl font-bold text-cream mb-8">Latest Post</h2>
                <article className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] overflow-hidden">
                  <div className="md:flex">
                    <div className="md:w-1/2">
                      <div className="h-64 md:h-full bg-gradient-to-br from-ink-surface to-ink-deep flex items-center justify-center">
                        <div className="text-cream text-center p-8">
                          <div className="text-4xl mb-4">📊</div>
                          <div className="text-lg font-semibold">Featured Article</div>
                        </div>
                      </div>
                    </div>
                    <div className="md:w-1/2 p-8">
                      <div className="flex items-center mb-4">
                        <span className={`inline-block px-3 py-1 text-xs font-semibold rounded-full ${getCategoryColor(filteredPosts[0].category)}`}>
                          {filteredPosts[0].category}
                        </span>
                        <span className="text-sm text-sand-dim ml-4">{filteredPosts[0].readTime}</span>
                      </div>
                      <h3 className="text-2xl font-bold text-cream mb-4">
                        {filteredPosts[0].available ? (
                          <Link href={filteredPosts[0].href} className="hover:text-gold transition-colors">
                            {filteredPosts[0].title}
                          </Link>
                        ) : (
                          filteredPosts[0].title
                        )}
                      </h3>
                      <p className="text-sand mb-6 leading-relaxed">
                        {filteredPosts[0].excerpt}
                      </p>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <div className="w-10 h-10 bg-gradient-to-br from-ink-surface to-ink-deep rounded-full flex items-center justify-center text-cream font-semibold">
                            {filteredPosts[0].author.split(' ').map(n => n[0]).join('')}
                          </div>
                          <div>
                            <div className="font-medium text-cream">{filteredPosts[0].author}</div>
                            <div className="text-sm text-sand-dim">{filteredPosts[0].publishDate}</div>
                          </div>
                        </div>
                        {filteredPosts[0].available ? (
                        <Link 
                          href={filteredPosts[0].href}
                          className="text-gold hover:text-gold-hi font-semibold flex items-center"
                        >
                          Read More
                          <svg className="ml-2 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </Link>
                        ) : (
                          <span className="text-sm font-semibold text-sand-dim">Coming soon</span>
                        )}
                      </div>
                    </div>
                  </div>
                </article>
              </div>

              {/* Rest of Posts */}
              <div className="mb-8">
                <h2 className="text-3xl font-bold text-cream mb-8">More Articles</h2>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {filteredPosts.slice(1).map((post) => (
                    <article key={post.id} className="bg-ink-surface rounded-lg shadow-[0_20px_60px_-30px_rgba(0,0,0,0.85)] overflow-hidden hover:shadow-xl transition-shadow">
                      <div className="h-48 bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center">
                        <div className="text-sand-dim text-center">
                          <div className="text-3xl mb-2">📖</div>
                          <div className="text-sm font-medium">{post.category}</div>
                        </div>
                      </div>
                      
                      <div className="p-6">
                        <div className="flex items-center justify-between mb-3">
                          <span className={`inline-block px-2 py-1 text-xs font-semibold rounded-full ${getCategoryColor(post.category)}`}>
                            {post.category}
                          </span>
                          <span className="text-xs text-sand-dim">{post.readTime}</span>
                        </div>
                        
                        <h3 className="text-lg font-bold text-cream mb-3 line-clamp-2">
                          {post.available ? (
                            <Link href={post.href} className="hover:text-gold transition-colors">
                              {post.title}
                            </Link>
                          ) : (
                            post.title
                          )}
                        </h3>
                        
                        <p className="text-sand text-sm mb-4 line-clamp-3">
                          {post.excerpt}
                        </p>
                        
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <div className="w-8 h-8 bg-gradient-to-br from-ink-surface to-ink-deep rounded-full flex items-center justify-center text-cream text-xs font-semibold">
                              {post.author.split(' ').map(n => n[0]).join('')}
                            </div>
                            <div>
                              <div className="text-xs font-medium text-cream">{post.author}</div>
                              <div className="text-xs text-sand-dim">{post.publishDate}</div>
                            </div>
                          </div>
                          {post.available ? (
                            <Link 
                              href={post.href}
                              className="text-gold hover:text-gold-hi text-sm font-semibold"
                            >
                              Read →
                            </Link>
                          ) : (
                            <span className="text-xs font-semibold text-sand-dim">Coming soon</span>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>

        {/* Educational Resources CTA */}
        <section className="bg-ink-surface">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-cream mb-4">New to Blockchain Savings Circles?</h2>
              <p className="text-lg text-sand">
                Start with our comprehensive educational resources to understand the fundamentals.
              </p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              <Link href="/learn/what-is-njangi" className="group">
                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    What is Njangi?
                  </h3>
                  <p className="text-sm text-gold">
                    Learn about Cameroon&rsquo;s traditional savings circles.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/blockchain-rosca" className="group">
                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Blockchain ROSCA
                  </h3>
                  <p className="text-sm text-gold">
                    Discover the future of community savings.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/tontine-blockchain" className="group">
                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Tontine Blockchain
                  </h3>
                  <p className="text-sm text-gold">
                    African finance meets blockchain technology.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/sou-sou-crypto" className="group">
                <div className="bg-gold/[0.07] border border-gold/45 rounded-lg p-6 hover:border-gold/45 hover:shadow-[0_14px_40px_-24px_rgba(0,0,0,0.8)] transition-all">
                  <h3 className="font-semibold text-gold group-hover:text-gold mb-2">
                    Sou Sou Crypto
                  </h3>
                  <p className="text-sm text-gold">
                    Caribbean savings circles go digital.
                  </p>
                </div>
              </Link>
            </div>
          </div>
        </section>

        {/* Newsletter Signup */}
        <section className="bg-gradient-to-r from-ink-surface to-ink-deep text-cream">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <h2 className="text-3xl font-bold mb-4">Stay Updated</h2>
            <p className="text-xl text-cream-muted mb-8 max-w-2xl mx-auto">
              Get the latest insights about blockchain savings circles, success stories, 
              and educational content delivered to your inbox.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center max-w-md mx-auto">
              <input 
                type="email" 
                placeholder="Enter your email"
                className="flex-1 px-4 py-3 rounded-lg text-cream focus:outline-none focus:ring-2 focus:ring-white"
              />
              <button className="bg-ink-surface text-gold px-8 py-3 rounded-lg font-semibold hover:bg-ink-surface transition-colors">
                Subscribe
              </button>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="bg-ink-surface">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <p className="text-sm text-sand text-center">
              <strong>Disclaimer:</strong> Content is for educational purposes only and does not constitute financial advice. 
              Always consult with qualified financial advisors before making investment decisions.
            </p>
          </div>
        </footer>
      </MarketingShell>
    </>
  );
} 