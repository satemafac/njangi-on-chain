import Head from 'next/head';
import Link from 'next/link';

export default function LearnIndexPage() {
  const articles = [
    {
      title: "What is Njangi?",
      subtitle: "Understanding Cameroon's Traditional Savings Circle",
      description: "Discover how Njangi works and how blockchain technology revolutionizes traditional Cameroon savings circles.",
      href: "/learn/what-is-njangi",
      tag: "Fundamentals",
      readTime: "5 min read",
      color: "green"
    },
    {
      title: "Blockchain ROSCA",
      subtitle: "The Future of Community Savings",
      description: "Learn how blockchain technology transforms traditional ROSCAs worldwide with smart contracts and DeFi.",
      href: "/learn/blockchain-rosca",
      tag: "Technology",
      readTime: "7 min read",
      color: "blue"
    },
    {
      title: "Tontine Blockchain",
      subtitle: "Revolutionizing African Finance",
      description: "Explore how French African tontine traditions are digitized through blockchain for modern communities.",
      href: "/learn/tontine-blockchain",
      tag: "Regional Focus",
      readTime: "9 min read",
      color: "purple"
    },
    {
      title: "Sou Sou Crypto",
      subtitle: "Caribbean Savings Circles Meet Blockchain",
      description: "See how Caribbean and West African susu traditions embrace cryptocurrency and smart contracts.",
      href: "/learn/sou-sou-crypto",
      tag: "Cultural Traditions",
      readTime: "8 min read",
      color: "orange"
    }
  ];

  const getColorClasses = (color: string) => {
    const colors = {
      green: {
        border: "border-green-200",
        bg: "bg-green-50",
        text: "text-green-600",
        hover: "hover:border-green-300"
      },
      blue: {
        border: "border-blue-200",
        bg: "bg-blue-50",
        text: "text-blue-600",
        hover: "hover:border-blue-300"
      },
      purple: {
        border: "border-purple-200",
        bg: "bg-purple-50",
        text: "text-purple-600",
        hover: "hover:border-purple-300"
      },
      orange: {
        border: "border-orange-200",
        bg: "bg-orange-50",
        text: "text-orange-600",
        hover: "hover:border-orange-300"
      }
    };
    return colors[color as keyof typeof colors] || colors.blue;
  };

  return (
    <>
      <Head>
        <title>Learn About Blockchain Savings Circles | Njangi Platform Education Center</title>
        <meta name="description" content="Learn about traditional savings circles from around the world and how blockchain technology revolutionizes community finance. Educational resources on Njangi, ROSCA, Tontine, and Sou Sou systems." />
        <meta name="keywords" content="learn njangi, blockchain rosca education, tontine tutorial, sou sou guide, community savings education, cryptocurrency savings circles" />
        <link rel="canonical" href="https://njangionchain.com/learn" />
        
        {/* Open Graph / Facebook */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Learn About Blockchain Savings Circles | Njangi Platform" />
        <meta property="og:description" content="Educational resources on traditional savings circles and blockchain technology." />
        <meta property="og:url" content="https://njangionchain.com/learn" />
        <meta property="og:image" content="https://njangionchain.com/images/learn-hero.jpg" />

        {/* Twitter */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:title" content="Learn About Blockchain Savings Circles | Njangi Platform" />
        <meta property="twitter:description" content="Educational resources on traditional savings circles and blockchain technology." />
        <meta property="twitter:image" content="https://njangionchain.com/images/learn-hero.jpg" />
      </Head>

      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-blue-50">
        {/* Navigation Breadcrumb */}
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center space-x-2 py-3 text-sm text-gray-600">
              <Link href="/" className="hover:text-blue-600 transition-colors">Home</Link>
              <span>/</span>
              <span className="text-gray-900 font-medium">Learn</span>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="relative bg-gradient-to-r from-indigo-600 to-purple-600 text-white py-20">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center">
              <h1 className="text-4xl md:text-6xl font-bold mb-6">
                Learn About Blockchain Savings Circles
              </h1>
              <p className="text-xl md:text-2xl mb-8 text-indigo-100 max-w-4xl mx-auto">
                Discover how traditional savings circles from around the world are being revolutionized 
                by blockchain technology, smart contracts, and decentralized finance.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link 
                  href="/create-circle" 
                  className="bg-white text-indigo-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
                >
                  Start Learning by Doing →
                </Link>
                <Link 
                  href="#articles" 
                  className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-indigo-600 transition-colors"
                >
                  Browse Articles
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Quick Stats */}
        <section className="bg-white border-b">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
              <div>
                <div className="text-3xl font-bold text-indigo-600 mb-2">1B+</div>
                <div className="text-sm text-gray-600">People use traditional savings circles globally</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-green-600 mb-2">200+</div>
                <div className="text-sm text-gray-600">Countries with active savings circle traditions</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-purple-600 mb-2">$500B+</div>
                <div className="text-sm text-gray-600">Annual volume through informal savings systems</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-orange-600 mb-2">8%</div>
                <div className="text-sm text-gray-600">Average yield potential with blockchain integration</div>
              </div>
            </div>
          </div>
        </section>

        {/* Main Learning Articles */}
        <section id="articles" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">Educational Articles</h2>
            <p className="text-lg text-gray-600 max-w-3xl mx-auto">
              Start with the fundamentals and progress through regional variations to understand 
              how blockchain technology transforms traditional community finance.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {articles.map((article, index) => {
              const colorClasses = getColorClasses(article.color);
              return (
                <Link key={index} href={article.href} className="group">
                  <article className={`border ${colorClasses.border} ${colorClasses.hover} rounded-lg overflow-hidden shadow-lg hover:shadow-xl transition-all duration-300`}>
                    <div className={`${colorClasses.bg} p-4`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className={`text-xs font-semibold ${colorClasses.text} bg-white px-2 py-1 rounded`}>
                          {article.tag}
                        </span>
                        <span className="text-xs text-gray-500">{article.readTime}</span>
                      </div>
                    </div>
                    
                    <div className="p-6">
                      <h3 className="text-xl font-bold text-gray-900 mb-2 group-hover:text-indigo-600 transition-colors">
                        {article.title}
                      </h3>
                      <h4 className={`text-lg font-semibold ${colorClasses.text} mb-3`}>
                        {article.subtitle}
                      </h4>
                      <p className="text-gray-600 text-sm leading-relaxed">
                        {article.description}
                      </p>
                      
                      <div className="mt-4 flex items-center text-sm text-indigo-600 group-hover:text-indigo-700">
                        Read Article
                        <svg className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>
                  </article>
                </Link>
              );
            })}
          </div>
        </section>

        {/* Learning Path */}
        <section className="bg-white">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-gray-900 mb-4">Recommended Learning Path</h2>
              <p className="text-lg text-gray-600">
                Follow this sequence to build a comprehensive understanding of blockchain savings circles.
              </p>
            </div>

            <div className="relative">
              {/* Learning path line */}
              <div className="hidden md:block absolute left-1/2 transform -translate-x-1/2 w-1 bg-gradient-to-b from-green-400 via-blue-400 via-purple-400 to-orange-400 h-full"></div>
              
              <div className="space-y-12">
                {articles.map((article, index) => {
                  const colorClasses = getColorClasses(article.color);
                  const isEven = index % 2 === 0;
                  
                  return (
                    <div key={index} className={`flex items-center ${isEven ? 'md:flex-row' : 'md:flex-row-reverse'}`}>
                      <div className={`flex-1 ${isEven ? 'md:pr-8' : 'md:pl-8'}`}>
                        <div className={`bg-white border ${colorClasses.border} rounded-lg p-6 shadow-lg`}>
                          <div className="flex items-center mb-3">
                            <div className={`w-8 h-8 ${colorClasses.bg} ${colorClasses.text} rounded-full flex items-center justify-center font-bold text-sm mr-3`}>
                              {index + 1}
                            </div>
                            <span className={`text-xs font-semibold ${colorClasses.text} bg-gray-100 px-2 py-1 rounded`}>
                              {article.tag}
                            </span>
                          </div>
                          <h3 className="text-xl font-bold text-gray-900 mb-2">{article.title}</h3>
                          <p className="text-gray-600 text-sm mb-4">{article.description}</p>
                          <Link 
                            href={article.href}
                            className={`inline-flex items-center text-sm font-semibold ${colorClasses.text} hover:underline`}
                          >
                            Start Reading
                            <svg className="ml-1 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </Link>
                        </div>
                      </div>
                      
                      {/* Center dot - only visible on larger screens */}
                      <div className="hidden md:flex w-4 h-4 bg-white border-4 border-indigo-400 rounded-full relative z-10"></div>
                      
                      <div className="flex-1"></div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Topics Overview */}
        <section className="bg-gray-50">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-gray-900 mb-4">Topics Covered</h2>
              <p className="text-lg text-gray-600">
                Comprehensive coverage of traditional and blockchain-powered savings systems.
              </p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
              <div className="bg-white rounded-lg p-6 shadow-lg">
                <h3 className="text-lg font-semibold text-gray-900 mb-3">Traditional Systems</h3>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li>• Historical origins and cultural significance</li>
                  <li>• How rotating savings circles work</li>
                  <li>• Regional variations worldwide</li>
                  <li>• Common challenges and limitations</li>
                </ul>
              </div>

              <div className="bg-white rounded-lg p-6 shadow-lg">
                <h3 className="text-lg font-semibold text-gray-900 mb-3">Blockchain Technology</h3>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li>• Smart contract automation</li>
                  <li>• Cryptographic security benefits</li>
                  <li>• Transparent and immutable records</li>
                  <li>• Global accessibility features</li>
                </ul>
              </div>

              <div className="bg-white rounded-lg p-6 shadow-lg">
                <h3 className="text-lg font-semibold text-gray-900 mb-3">DeFi Integration</h3>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li>• Yield generation strategies</li>
                  <li>• Multi-currency support</li>
                  <li>• Risk management protocols</li>
                  <li>• Real-world implementation</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <h2 className="text-3xl font-bold mb-4">Ready to Apply What You&rsquo;ve Learned?</h2>
            <p className="text-xl text-indigo-100 mb-8 max-w-3xl mx-auto">
              Join thousands of people worldwide who are using blockchain technology to enhance 
              their traditional savings circles with security, transparency, and yield generation.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/create-circle"
                className="bg-white text-indigo-600 px-8 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
              >
                Create Your Circle
              </Link>
              <Link 
                href="/dashboard"
                className="border-2 border-white text-white px-8 py-3 rounded-lg font-semibold hover:bg-white hover:text-indigo-600 transition-colors"
              >
                Browse Existing Circles
              </Link>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="bg-gray-100">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <p className="text-sm text-gray-600 text-center">
              <strong>Educational Disclaimer:</strong> This content is for educational purposes only and does not constitute financial advice. 
              Always consult with qualified financial advisors before making investment decisions.
            </p>
          </div>
        </footer>
      </div>
    </>
  );
} 