'use client';

import React from 'react';
import Link from 'next/link';
import { usePrivy } from '@privy-io/react-auth';
import UserMenu from '../components/UserMenu';
import Chat from '../components/Chat';
import Logo from '../image/logo.png';
import { SpinningLogo } from '../components/SpinningLogo';

export default function Home() {
  const { login, authenticated } = usePrivy();

  return (
    <main className="relative min-h-screen w-full bg-black text-white flex flex-col items-center justify-center p-8">
      {/* HEADER CONTAINER: full width, aligns logo left and menu right at same height */}
      <div className="absolute top-8 left-0 right-0 flex items-center justify-between px-8 z-50">
        <Link href="/" className="flex items-center gap-3 hover:opacity-90 transition-opacity">
          <SpinningLogo
            src={Logo}
            alt="Altair logo"
            className="h-20 w-auto"
            priority
          />
        </Link>
        <UserMenu />
      </div>

      {/* Content Container */}
      <div className="w-full flex flex-col items-center gap-8">
        <div className="flex items-center gap-4">
          <SpinningLogo src={Logo} alt="Altair logo" className="h-23 w-auto" />
          <div className="text-left">
            <h1 className="text-5xl font-extrabold mb-2 bg-gradient-to-r from-blue-400 to-purple-600 bg-clip-text text-transparent">
              Altair
            </h1>
            <p className="text-gray-400 font-medium italic">
              {authenticated ? "Your crypto trading assistant." : "Your concierge for DeFi on Base."}
            </p>
          </div>
        </div>

        {authenticated ? (
          <Chat /> // The Chat UI appears here when logged in
        ) : (
          <button 
            onClick={login}
            className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-full transition-all shadow-lg shadow-blue-500/20 mt-4"
          >
            Connect to Altair
          </button>
        )}
      </div>

      
    </main>
  );
}
