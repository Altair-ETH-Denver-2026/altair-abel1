'use client';

import React, { useState, useRef, useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { UserRound, LogOut, Settings, Wallet, Wrench, Copy } from 'lucide-react';
import { useEffect as useClientEffect, useState as useClientState } from 'react';
import { BALANCE_DECIMALS } from '../../config';

export default function UserMenu() {
  const { logout, authenticated, getAccessToken } = usePrivy();
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isWalletOpen, setIsWalletOpen] = useState(false);
  const [isDevOpen, setIsDevOpen] = useState(false);
  const [ethBalance, setEthBalance] = useClientState<string>('0');
  const [usdcBalance, setUsdcBalance] = useClientState<string>('0');
  const [evmAddress, setEvmAddress] = useClientState<string>('');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsProfileOpen(false);
        setIsWalletOpen(false);
        setIsDevOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useClientEffect(() => {
    const controller = new AbortController();

    const run = async () => {
      if (!authenticated) {
        setEthBalance('0');
        setUsdcBalance('0');
        setEvmAddress('');
        return;
      }

      const token =
        (typeof getAccessToken === 'function' ? await getAccessToken() : null)
        ?? (typeof window !== 'undefined' ? localStorage.getItem('privy:token') : null);
      if (!token) return;

      try {
        const res = await fetch('/api/balances', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ accessToken: token }),
          signal: controller.signal,
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || 'Failed to fetch balances');
        }
        if (data?.eth) setEthBalance(data.eth);
        if (data?.usdc) setUsdcBalance(data.usdc);
        if (data?.address) setEvmAddress(data.address);
      } catch {
        setEthBalance('0');
        setUsdcBalance('0');
        setEvmAddress('');
      }
    };

    run();

    return () => controller.abort();
  }, [authenticated, setEthBalance, setUsdcBalance, setEvmAddress]);

  if (!authenticated) return null;

  return (
    <div className="relative flex items-center gap-3" ref={menuRef}>
      {/* Dev tools dropdown */}
      <div className="relative">
        <button
          onClick={() => {
            setIsDevOpen(!isDevOpen);
            setIsWalletOpen(false);
            setIsProfileOpen(false);
          }}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-gray-800 border border-gray-700 hover:border-blue-500 transition-all shadow-md cursor-pointer"
        >
          <Wrench className="w-6 h-6 text-gray-300" />
        </button>
        {isDevOpen && (
          <div className="absolute right-0 mt-3 w-48 rounded-xl bg-gray-900 border border-gray-700 shadow-2xl z-[100] overflow-hidden flex flex-col">
            <button
              onClick={async () => {
                const token =
                  (typeof getAccessToken === 'function' ? await getAccessToken() : null)
                  ?? (typeof window !== 'undefined' ? localStorage.getItem('privy:token') : null);
                await fetch('/api/test-swap', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({ accessToken: token }),
                }).catch(() => {});
                setIsDevOpen(false);
              }}
              className="flex w-full items-center px-4 py-3 text-sm text-gray-300 hover:bg-gray-800 transition-colors text-left"
            >
              <span className="flex-1">Test Swap: 0.00001 ETH</span>
            </button>
            <div className="h-[1px] bg-gray-700 w-full" />
            <button
              onClick={() => setIsDevOpen(false)}
              className="flex w-full items-center px-4 py-3 text-sm text-gray-300 hover:bg-gray-800 transition-colors text-left"
            >
              <span className="flex-1">Test Withdraw</span>
            </button>
          </div>
        )}
      </div>

      {/* Wallet dropdown */}
      <div className="relative">
        <button
          onClick={() => {
            setIsWalletOpen(!isWalletOpen);
            setIsProfileOpen(false);
            setIsDevOpen(false);
          }}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-gray-800 border border-gray-700 hover:border-blue-500 transition-all shadow-md cursor-pointer"
        >
          <Wallet className="w-6 h-6 text-gray-300" />
        </button>
            {isWalletOpen && (
          <div className="absolute right-0 mt-3 w-48 rounded-xl bg-gray-900 border border-gray-700 shadow-2xl z-[100] overflow-hidden flex flex-col">
            <div className="flex w-full items-center px-4 py-3 text-sm text-gray-300 break-all">
              <button
                type="button"
                onClick={() => {
                  if (evmAddress) navigator.clipboard?.writeText(evmAddress).catch(() => {});
                }}
                className="text-left cursor-pointer"
                title={evmAddress || 'Unknown'}
              >
                <Copy className="w-4 h-4" />
              </button>
              <span className="text-gray-100 px-3 text-right flex-1 text-sm" title={evmAddress || 'Unknown'}>
                {evmAddress ? `${evmAddress.slice(0, 6)}...${evmAddress.slice(-4)}` : '—'}
              </span>
            </div>
            <div className="h-[1px] bg-gray-700 w-full" />
            <div className="flex w-full items-center px-4 py-3 text-sm text-gray-300">
              <span className="flex-1">ETH</span>
              <span
                className="text-gray-100 px-3 text-center whitespace-nowrap hover:whitespace-normal"
                title={ethBalance}
              >
                {Number.isNaN(Number(ethBalance))
                  ? ethBalance
                  : Number(ethBalance).toFixed(BALANCE_DECIMALS)}
              </span>
            </div>
            <div className="h-[1px] bg-gray-700 w-full" />
            <div className="flex w-full items-center px-4 py-3 text-sm text-gray-300">
              <span className="flex-1">USDC</span>
              <span
                className="text-gray-100 px-3 text-center whitespace-nowrap hover:whitespace-normal"
                title={usdcBalance}
              >
                {Number.isNaN(Number(usdcBalance))
                  ? usdcBalance
                  : Number(usdcBalance).toFixed(BALANCE_DECIMALS)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Profile dropdown */}
      <div className="relative">
        <button
          onClick={() => {
            setIsProfileOpen(!isProfileOpen);
            setIsWalletOpen(false);
          }}
          className="flex items-center justify-center w-10 h-10 rounded-full bg-gray-800 border border-gray-700 hover:border-blue-500 transition-all shadow-md cursor-pointer"
        >
          <UserRound className="w-6 h-6 text-gray-300" />
        </button>

        {isProfileOpen && (
          // right-0 ensures the menu grows to the left, staying on screen
          <div className="absolute right-0 mt-3 w-48 rounded-xl bg-gray-900 border border-gray-700 shadow-2xl z-[100] overflow-hidden flex flex-col">
            <button
              onClick={() => { alert('Coming soon!'); setIsProfileOpen(false); }}
              className="flex w-full items-center px-4 py-3 text-sm text-gray-300 hover:bg-gray-800 transition-colors text-left"
            >
              <Settings className="w-4 h-4 mr-3" />
              <span className="flex-1">Edit Profile</span>
            </button>
            
            <div className="h-[1px] bg-gray-700 w-full" />
            
            <button
              onClick={() => { logout(); setIsProfileOpen(false); }}
              className="flex w-full items-center px-4 py-3 text-sm text-red-400 hover:bg-gray-800 transition-colors text-left"
            >
              <LogOut className="w-4 h-4 mr-3" />
              <span className="flex-1">Log Out</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

