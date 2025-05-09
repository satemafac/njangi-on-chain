import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../contexts/AuthContext';
import { LoginButton } from '../components/LoginButton';
import Image from 'next/image';
import Link from 'next/link';

export default function Home() {
  const router = useRouter();
  const { account } = useAuth();
  const [openFaqItems, setOpenFaqItems] = useState<{[key: string]: boolean}>({});

  const toggleFaqItem = (id: string) => {
    setOpenFaqItems(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  useEffect(() => {
    if (account) {
      router.push('/dashboard');
    }
  }, [account, router]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero Section */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="py-12 md:py-20">
          <div className="text-center">
            <div className="flex justify-center mb-8">
              <Image
                src="/njangi-on-chain-logo.png"
                alt="Njangi on-chain"
                width={120}
                height={120}
                priority
              />
            </div>
            <h1 className="text-4xl tracking-tight font-extrabold text-gray-900 sm:text-5xl md:text-6xl">
              <span className="block">Welcome to</span>
              <span className="block text-blue-600">Njangi On-Chain</span>
            </h1>
            <p className="mt-3 max-w-md mx-auto text-base text-gray-500 sm:text-lg md:mt-5 md:text-xl md:max-w-3xl">
              Empowering communities with secure, transparent, and culturally rich savings circles.
              Built on Sui blockchain with zkLogin for seamless authentication.
            </p>
            
            <div className="mt-10">
              <LoginButton />
            </div>
          </div>

          {/* Feature Cards */}
          <div className="mt-20">
            <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
              <div className="text-center">
                <div className="flex items-center justify-center h-12 w-12 rounded-md bg-blue-500 text-white mx-auto">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <h3 className="mt-4 text-lg font-medium text-gray-900">Secure</h3>
                <p className="mt-2 text-base text-gray-500">
                  Built on Sui blockchain with zkLogin authentication for maximum security.
                </p>
              </div>

              <div className="text-center">
                <div className="flex items-center justify-center h-12 w-12 rounded-md bg-blue-500 text-white mx-auto">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                </div>
                <h3 className="mt-4 text-lg font-medium text-gray-900">Community-Driven</h3>
                <p className="mt-2 text-base text-gray-500">
                  Preserving cultural traditions while modernizing community savings.
                </p>
              </div>

              <div className="text-center">
                <div className="flex items-center justify-center h-12 w-12 rounded-md bg-blue-500 text-white mx-auto">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="mt-4 text-lg font-medium text-gray-900">Transparent</h3>
                <p className="mt-2 text-base text-gray-500">
                  Full transparency and automated management of savings circles.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Everything You Need Section */}
      <div className="bg-white py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-extrabold text-gray-900 sm:text-4xl">
              Everything you need to manage your Njangi on the blockchain
            </h2>
            <p className="mt-4 text-lg text-gray-500">
              For the first time, bringing the traditional Njangi to the decentralized world
            </p>
          </div>
          
          <div className="mt-16 grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
            <div className="bg-gray-50 rounded-lg p-6 shadow-sm">
              <div className="flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 text-blue-600 mb-4">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900">Unlimited Groups</h3>
              <p className="mt-2 text-gray-500">Create and manage unlimited number of Groups of any size with on-chain security.</p>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-6 shadow-sm">
              <div className="flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 text-blue-600 mb-4">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900">Decentralized Payments</h3>
              <p className="mt-2 text-gray-500">Pay or get paid directly through Sui blockchain with full transparency and no intermediaries.</p>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-6 shadow-sm">
              <div className="flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 text-blue-600 mb-4">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900">Provably Fair Order</h3>
              <p className="mt-2 text-gray-500">Smart contract-enforced random payout order that&apos;s transparent and tamper-proof.</p>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-6 shadow-sm">
              <div className="flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 text-blue-600 mb-4">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900">Automatic Reminders</h3>
              <p className="mt-2 text-gray-500">Get reminded about payment due dates through smart contract events and notifications.</p>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-6 shadow-sm">
              <div className="flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 text-blue-600 mb-4">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900">zkLogin Authentication</h3>
              <p className="mt-2 text-gray-500">Login with your favorite social accounts while maintaining crypto-level security through zero-knowledge proofs.</p>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-6 shadow-sm">
              <div className="flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 text-blue-600 mb-4">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900">100% Secure and Trustless</h3>
              <p className="mt-2 text-gray-500">All transactions are secured by Sui blockchain with full verification and auditability.</p>
            </div>
          </div>
        </div>
      </div>

      {/* How It Works Section */}
      <div className="bg-blue-50 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-extrabold text-gray-900 sm:text-4xl">
              How It Works
            </h2>
            <p className="mt-4 text-lg text-gray-500">
              Using Njangi On-Chain is as easy as A-B-C
            </p>
          </div>
          
          <div className="mt-16 grid grid-cols-1 gap-8 md:grid-cols-3">
            <div className="text-center">
              <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-blue-100 text-blue-600 text-2xl font-bold">
                A
              </div>
              <h3 className="mt-4 text-lg font-medium text-gray-900">Login with zkLogin</h3>
              <p className="mt-2 text-gray-500">
                Use your Google, Facebook, or other social accounts to log in securely with zero-knowledge proofs.
              </p>
            </div>
            
            <div className="text-center">
              <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-blue-100 text-blue-600 text-2xl font-bold">
                B
              </div>
              <h3 className="mt-4 text-lg font-medium text-gray-900">Create or Join a Group</h3>
              <p className="mt-2 text-gray-500">
                Create your own Njangi group or join an existing one by connecting with members.
              </p>
            </div>
            
            <div className="text-center">
              <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-blue-100 text-blue-600 text-2xl font-bold">
                C
              </div>
              <h3 className="mt-4 text-lg font-medium text-gray-900">Manage On-Chain</h3>
              <p className="mt-2 text-gray-500">
                Let smart contracts handle contributions, payouts, and order management with full transparency.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Section */}
      <div className="bg-white py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
            <div className="text-center">
              <span className="block text-4xl font-extrabold text-blue-600">10+</span>
              <span className="block mt-2 text-lg text-gray-500">Countries</span>
            </div>
            
            <div className="text-center">
              <span className="block text-4xl font-extrabold text-blue-600">5</span>
              <span className="block mt-2 text-lg text-gray-500">Currencies</span>
            </div>
            
            <div className="text-center">
              <span className="block text-4xl font-extrabold text-blue-600">1k+</span>
              <span className="block mt-2 text-lg text-gray-500">Users</span>
            </div>
            
            <div className="text-center">
              <span className="block text-4xl font-extrabold text-blue-600">5k+</span>
              <span className="block mt-2 text-lg text-gray-500">Transactions</span>
            </div>
          </div>
        </div>
      </div>

      {/* FAQ Section Preview */}
      <div className="bg-gray-50 py-16">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-extrabold text-gray-900 sm:text-4xl">
              Frequently Asked Questions
            </h2>
            <p className="mt-4 text-lg text-gray-500">
              Common questions about Njangi On-Chain
            </p>
          </div>
          
          <div className="space-y-6">
            <div className="bg-white shadow overflow-hidden rounded-lg">
              <button 
                className="w-full px-6 py-4 text-left"
                onClick={() => toggleFaqItem('what-is-njangi')}
                aria-expanded={openFaqItems['what-is-njangi']}
              >
                <div className="flex justify-between items-center">
                  <span className="text-lg font-medium text-gray-900">What is a Njangi?</span>
                  <svg 
                    className={`h-5 w-5 text-gray-500 transform ${openFaqItems['what-is-njangi'] ? 'rotate-180' : ''} transition-transform duration-200`} 
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>
              <div 
                className={`px-6 pb-4 ${openFaqItems['what-is-njangi'] ? 'block' : 'hidden'}`}
              >
                <p className="text-gray-500">
                  A Njangi is a community-based savings system where members contribute funds together in a rotation for the equal benefit of every member. Our platform brings this cultural tradition to the blockchain.
                </p>
              </div>
            </div>
            
            <div className="bg-white shadow overflow-hidden rounded-lg">
              <button 
                className="w-full px-6 py-4 text-left"
                onClick={() => toggleFaqItem('how-different')}
                aria-expanded={openFaqItems['how-different']}
              >
                <div className="flex justify-between items-center">
                  <span className="text-lg font-medium text-gray-900">How is Njangi On-Chain different?</span>
                  <svg 
                    className={`h-5 w-5 text-gray-500 transform ${openFaqItems['how-different'] ? 'rotate-180' : ''} transition-transform duration-200`} 
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>
              <div 
                className={`px-6 pb-4 ${openFaqItems['how-different'] ? 'block' : 'hidden'}`}
              >
                <p className="text-gray-500">
                  Unlike traditional Njangi systems, our platform uses Sui blockchain to provide transparent, secure, and automated management of savings circles with cryptographic guarantees and full auditability.
                </p>
              </div>
            </div>
            
            <div className="text-center mt-8">
              <Link href="/faq" className="text-blue-600 hover:text-blue-800 font-medium">
                View all FAQs
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Cultural Names Section */}
      <div className="bg-blue-600 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-white text-center mb-8">
            One Global Movement, Countless Cultural Expressions
          </h2>
          <div className="flex flex-wrap justify-center gap-3 text-white">
            {["Adaji", "Ajoh", "Asue", "Arisan", "Cadena", "Chama", "ChitFunds", "Cundina",
              "Equb", "Esusu", "Family-Lottery", "Hagbad", "Hui", "Idir", "Iqub", "Keyes",
              "Kibata", "Kikoba", "Micro-Credit", "Mujin", "Njangi", "Paluwagan", "Pandero",
              "Pari", "ROSCA", "Round", "Samity", "SittuDanawa", "Sou-sou", "Pardner",
              "Stokvel", "Tanda", "Tontine"].map((name, index) => (
              <span key={index} className="bg-blue-500 px-3 py-1 rounded-full text-sm">
                {name}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Footer with Social Links */}
      <footer className="bg-gray-900 text-white py-6">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between">
            <div className="flex items-center mb-4 md:mb-0">
              <Image
                src="/njangi-on-chain-logo.png"
                alt="Njangi on-chain"
                width={40}
                height={40}
                className="mr-3"
              />
              <div>
                <span className="text-lg font-semibold">Njangi On-Chain</span>
                <p className="text-xs text-gray-400 mt-1">
                  Empowering communities with secure, transparent savings on Sui blockchain.
                </p>
              </div>
            </div>
            
            <div className="flex items-center space-x-1">
              <span className="text-sm font-medium mr-3">Connect With Us:</span>
              <a href="https://x.com/njangi_on_chain" target="_blank" rel="noopener noreferrer" className="p-2 hover:text-blue-400 transition-colors">
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
                </svg>
              </a>
              <a href="https://www.instagram.com/njangionchain" target="_blank" rel="noopener noreferrer" className="p-2 hover:text-pink-400 transition-colors">
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
                </svg>
              </a>
              <a href="mailto:njangionchain@gmail.com" className="p-2 hover:text-blue-400 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M1.5 8.67v8.58a3 3 0 003 3h15a3 3 0 003-3V8.67l-8.928 5.493a3 3 0 01-3.144 0L1.5 8.67z" />
                  <path d="M22.5 6.908V6.75a3 3 0 00-3-3h-15a3 3 0 00-3 3v.158l9.714 5.978a1.5 1.5 0 001.572 0L22.5 6.908z" />
                </svg>
              </a>
            </div>
          </div>
          
          <div className="mt-4 pt-4 border-t border-gray-800 text-center text-gray-400 text-xs">
            <p>&copy; {new Date().getFullYear()} Njangi On-Chain. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
} 