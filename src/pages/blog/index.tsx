import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';

export default function BlogIndexPage() {
  const [activeCategory, setActiveCategory] = useState('all');

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
      image: '/images/blog/traditional-vs-blockchain.jpg',
      href: '/blog/traditional-savings-vs-blockchain'
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
      image: '/images/blog/diaspora-remittances.jpg',
      href: '/blog/african-diaspora-remittances'
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
      image: '/images/blog/caribbean-entrepreneurs.jpg',
      href: '/blog/caribbean-sou-sou-success-stories'
    },
    {
      id: 'defi-yield-strategies-community-savings',
      title: "DeFi Yield Strategies for Community Savings: A Beginner's Guide",
      excerpt: "Understanding how to safely generate 3-8% returns on community savings funds through decentralized finance protocols.",
      category: 'DeFi',
      readTime: '15 min read',
      publishDate: '2024-01-08',
      author: 'Dr. James Okonkwo',
      tags: ['defi', 'yield-farming', 'education'],
      image: '/images/blog/defi-yield-guide.jpg',
      href: '/blog/defi-yield-strategies-community-savings'
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
      image: '/images/blog/women-led-circles.jpg',
      href: '/blog/women-led-savings-circles-africa'
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
      image: '/images/blog/regulatory-landscape.jpg',
      href: '/blog/regulatory-landscape-blockchain-savings'
    }
  ];

  const categories = ['all', 'Technology', 'Diaspora', 'Success Stories', 'DeFi', 'Social Impact', 'Regulation'];

  const filteredPosts = activeCategory === 'all' 
    ? blogPosts 
    : blogPosts.filter(post => post.category === activeCategory);

  const getCategoryColor = (category: string) => {
    const colors = {
      'Technology': 'bg-blue-100 text-blue-800',
      'Diaspora': 'bg-green-100 text-green-800',
      'Success Stories': 'bg-purple-100 text-purple-800',
      'DeFi': 'bg-orange-100 text-orange-800',
      'Social Impact': 'bg-pink-100 text-pink-800',
      'Regulation': 'bg-gray-100 text-gray-800'
    };
    return colors[category as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  return (
    <>
      <Head>
        <title>Blockchain Savings Circle Blog | Insights & Stories from the Community</title>
        <meta name="description" content="Latest insights, success stories, and educational content about blockchain savings circles, traditional ROSCAs, and community finance from around the world." />
        <meta name="keywords" content="blockchain savings blog, rosca news, njangi stories, tontine insights, sou sou success, community finance blog" />
        <link rel="canonical" href="https://njangionchain.com/blog" />
        
        {/* Open Graph / Facebook */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Blockchain Savings Circle Blog | Community Finance Insights" />
        <meta property="og:description" content="Latest insights and stories about blockchain savings circles and community finance." />
        <meta property="og:url" content="https://njangionchain.com/blog" />
        <meta property="og:image" content="https://njangionchain.com/images/blog-hero.jpg" />

        {/* Twitter */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:title" content="Blockchain Savings Circle Blog" />
        <meta property="twitter:description" content="Latest insights and stories about blockchain savings circles and community finance." />
        <meta property="twitter:image" content="https://njangionchain.com/images/blog-hero.jpg" />
      </Head>

      <div className="min-h-screen bg-gray-50">
        {/* Navigation */}
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-gray-600">
              <Link href="/" className="hover:text-indigo-600 transition-colors">Home</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">Blog</span>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white py-16">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center">
              <h1 className="text-4xl md:text-5xl font-bold mb-6">
                Blockchain Savings Circle Blog
              </h1>
              <p className="text-xl md:text-2xl mb-8 text-indigo-100 max-w-4xl mx-auto">
                Insights, stories, and education about the future of community finance—from traditional 
                savings circles to blockchain-powered innovation.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link 
                  href="/learn" 
                  className="bg-white text-indigo-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
                >
                  Educational Resources →
                </Link>
                <Link 
                  href="#featured" 
                  className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-indigo-600 transition-colors"
                >
                  Latest Posts
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Category Filter */}
        <section className="bg-white border-b">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex flex-wrap gap-3">
              {categories.map((category) => (
                <button
                  key={category}
                  onClick={() => setActiveCategory(category)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeCategory === category
                      ? 'bg-indigo-100 text-indigo-700'
                      : 'hover:bg-gray-100 text-gray-600'
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
                <h2 className="text-3xl font-bold text-gray-900 mb-8">Latest Post</h2>
                <article className="bg-white rounded-lg shadow-lg overflow-hidden">
                  <div className="md:flex">
                    <div className="md:w-1/2">
                      <div className="h-64 md:h-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center">
                        <div className="text-white text-center p-8">
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
                        <span className="text-sm text-gray-500 ml-4">{filteredPosts[0].readTime}</span>
                      </div>
                      <h3 className="text-2xl font-bold text-gray-900 mb-4">
                        <Link href={filteredPosts[0].href} className="hover:text-indigo-600 transition-colors">
                          {filteredPosts[0].title}
                        </Link>
                      </h3>
                      <p className="text-gray-600 mb-6 leading-relaxed">
                        {filteredPosts[0].excerpt}
                      </p>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <div className="w-10 h-10 bg-gradient-to-br from-indigo-400 to-purple-500 rounded-full flex items-center justify-center text-white font-semibold">
                            {filteredPosts[0].author.split(' ').map(n => n[0]).join('')}
                          </div>
                          <div>
                            <div className="font-medium text-gray-900">{filteredPosts[0].author}</div>
                            <div className="text-sm text-gray-500">{filteredPosts[0].publishDate}</div>
                          </div>
                        </div>
                        <Link 
                          href={filteredPosts[0].href}
                          className="text-indigo-600 hover:text-indigo-700 font-semibold flex items-center"
                        >
                          Read More
                          <svg className="ml-2 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </Link>
                      </div>
                    </div>
                  </div>
                </article>
              </div>

              {/* Rest of Posts */}
              <div className="mb-8">
                <h2 className="text-3xl font-bold text-gray-900 mb-8">More Articles</h2>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {filteredPosts.slice(1).map((post) => (
                    <article key={post.id} className="bg-white rounded-lg shadow-lg overflow-hidden hover:shadow-xl transition-shadow">
                      <div className="h-48 bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center">
                        <div className="text-gray-500 text-center">
                          <div className="text-3xl mb-2">📖</div>
                          <div className="text-sm font-medium">{post.category}</div>
                        </div>
                      </div>
                      
                      <div className="p-6">
                        <div className="flex items-center justify-between mb-3">
                          <span className={`inline-block px-2 py-1 text-xs font-semibold rounded-full ${getCategoryColor(post.category)}`}>
                            {post.category}
                          </span>
                          <span className="text-xs text-gray-500">{post.readTime}</span>
                        </div>
                        
                        <h3 className="text-lg font-bold text-gray-900 mb-3 line-clamp-2">
                          <Link href={post.href} className="hover:text-indigo-600 transition-colors">
                            {post.title}
                          </Link>
                        </h3>
                        
                        <p className="text-gray-600 text-sm mb-4 line-clamp-3">
                          {post.excerpt}
                        </p>
                        
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <div className="w-8 h-8 bg-gradient-to-br from-indigo-400 to-purple-500 rounded-full flex items-center justify-center text-white text-xs font-semibold">
                              {post.author.split(' ').map(n => n[0]).join('')}
                            </div>
                            <div>
                              <div className="text-xs font-medium text-gray-900">{post.author}</div>
                              <div className="text-xs text-gray-500">{post.publishDate}</div>
                            </div>
                          </div>
                          <Link 
                            href={post.href}
                            className="text-indigo-600 hover:text-indigo-700 text-sm font-semibold"
                          >
                            Read →
                          </Link>
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
        <section className="bg-white">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-gray-900 mb-4">New to Blockchain Savings Circles?</h2>
              <p className="text-lg text-gray-600">
                Start with our comprehensive educational resources to understand the fundamentals.
              </p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              <Link href="/learn/what-is-njangi" className="group">
                <div className="bg-green-50 border border-green-200 rounded-lg p-6 hover:border-green-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-green-800 group-hover:text-green-900 mb-2">
                    What is Njangi?
                  </h3>
                  <p className="text-sm text-green-600">
                    Learn about Cameroon&rsquo;s traditional savings circles.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/blockchain-rosca" className="group">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 hover:border-blue-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-blue-800 group-hover:text-blue-900 mb-2">
                    Blockchain ROSCA
                  </h3>
                  <p className="text-sm text-blue-600">
                    Discover the future of community savings.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/tontine-blockchain" className="group">
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-6 hover:border-purple-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-purple-800 group-hover:text-purple-900 mb-2">
                    Tontine Blockchain
                  </h3>
                  <p className="text-sm text-purple-600">
                    African finance meets blockchain technology.
                  </p>
                </div>
              </Link>
              
              <Link href="/learn/sou-sou-crypto" className="group">
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-6 hover:border-orange-300 hover:shadow-md transition-all">
                  <h3 className="font-semibold text-orange-800 group-hover:text-orange-900 mb-2">
                    Sou Sou Crypto
                  </h3>
                  <p className="text-sm text-orange-600">
                    Caribbean savings circles go digital.
                  </p>
                </div>
              </Link>
            </div>
          </div>
        </section>

        {/* Newsletter Signup */}
        <section className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <h2 className="text-3xl font-bold mb-4">Stay Updated</h2>
            <p className="text-xl text-indigo-100 mb-8 max-w-2xl mx-auto">
              Get the latest insights about blockchain savings circles, success stories, 
              and educational content delivered to your inbox.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center max-w-md mx-auto">
              <input 
                type="email" 
                placeholder="Enter your email"
                className="flex-1 px-4 py-3 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-white"
              />
              <button className="bg-white text-indigo-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors">
                Subscribe
              </button>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="bg-gray-100">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <p className="text-sm text-gray-600 text-center">
              <strong>Disclaimer:</strong> Content is for educational purposes only and does not constitute financial advice. 
              Always consult with qualified financial advisors before making investment decisions.
            </p>
          </div>
        </footer>
      </div>
    </>
  );
} 