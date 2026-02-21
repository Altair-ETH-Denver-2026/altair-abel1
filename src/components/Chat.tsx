'use client';

import React, { useState, useRef, useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { SpinningLogo } from './SpinningLogo';
import { ShieldCheck, Send, Loader2 } from 'lucide-react';
import Logo from '../image/logo.png';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  zgHash?: string | null;
  zgError?: string | null;
}

type PreferredWallet = {
  walletId?: string;
  address?: string;
};

export default function Chat() {
  const { getAccessToken } = usePrivy();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [preferredWallet, setPreferredWallet] = useState<PreferredWallet | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Preflight wallet signability soon after login/session restore.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const accessToken =
          (typeof getAccessToken === 'function' ? await getAccessToken() : null)
          ?? (typeof window !== 'undefined' ? localStorage.getItem('privy:token') : null);
        if (!accessToken) return;
        const preflight = await fetch('/api/privy/ensure-signable-wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken }),
        });
        const preflightData = await preflight.json();
        if (!cancelled && preflightData?.ok && preflightData?.selectedWallet) {
          setPreferredWallet(preflightData.selectedWallet as PreferredWallet);
        }
      } catch (preflightErr) {
        console.warn('Privy onboarding preflight failed:', preflightErr);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken]);

  const handleSendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      const accessToken =
        (typeof getAccessToken === 'function' ? await getAccessToken() : null)
        ?? (typeof window !== 'undefined' ? localStorage.getItem('privy:token') : null);

      // Before first swap, attempt to auto-heal by ensuring a signable server wallet.
      const isSwapLikeMessage = /\b(swap|confirm swap|execute swap|swap now)\b/i.test(userMessage);
      let requestedWalletId = preferredWallet?.walletId;
      let requestedWalletAddress = preferredWallet?.address;
      if (accessToken && isSwapLikeMessage) {
        try {
          const preflight = await fetch('/api/privy/ensure-signable-wallet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken }),
          });
          const preflightData = await preflight.json();
          if (preflightData?.ok && preflightData?.selectedWallet) {
            const selected = preflightData.selectedWallet as PreferredWallet;
            requestedWalletId = selected.walletId;
            requestedWalletAddress = selected.address;
            setPreferredWallet(selected);
          }
        } catch (preflightErr) {
          console.warn('Privy signable wallet preflight failed:', preflightErr);
        }
      }

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          history: messages.map(m => ({ role: m.role, content: m.content })),
          accessToken,
          requestedWalletId,
          requestedWalletAddress,
        }),
      });

      const data = await response.json();
      
      setMessages((prev) => [...prev, { 
        role: 'assistant', 
        content: data.content,
        zgHash: data.zgHash,
        zgError: data.zgError,
      }]);
    } catch (error) {
      console.error("Chat error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-2xl bg-gray-900/50 border border-gray-800 rounded-2xl flex flex-col h-[500px] shadow-2xl backdrop-blur-sm">
      {/* Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-hide">
        {messages.length === 0 && (
          <p className="text-gray-500 text-center mt-20">Ask me to swap ETH for USDC or check your balance...</p>
        )}
        {messages.map((m, i) => (
          m.role === 'assistant' ? (
            <div key={i} className="flex items-start gap-3">
              <div className="shrink-0 h-10 w-10 rounded-full bg-white/5 border border-gray-700 flex items-center justify-center overflow-hidden">
                <SpinningLogo src={Logo} alt="Altair" className="h-9 w-9 object-contain" />
              </div>
              <div className="flex flex-col items-start">
                <div className="max-w-[85%] px-4 py-2 rounded-2xl text-sm bg-gray-800 text-gray-200">
                  {m.content}
                </div>
                {m.zgHash && !m.zgError && (
                  <div className="flex items-center gap-2 mt-1">
                    <a 
                      href={`https://scan-testnet.0g.ai/tx/${m.zgHash}`} 
                      target="_blank"
                      className="flex items-center gap-1 text-[10px] text-green-500 hover:underline"
                    >
                      <ShieldCheck className="w-3 h-3" />
                      Verified by 0g
                    </a>
                  </div>
                )}
                {m.zgError && (
                  <div className="flex items-center gap-2 mt-1 text-[10px] text-yellow-400" title={m.zgError}>
                    {`0G upload failed: ${m.zgError}`}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div key={i} className="flex flex-col items-end">
              <div className="max-w-[85%] px-4 py-2 rounded-2xl text-sm bg-blue-600 text-white">
                {m.content}
              </div>
            </div>
          )
        ))}
        {isLoading && (
          <div className="flex items-start gap-3">
            <div className="shrink-0 h-10 w-10 rounded-full bg-white/5 border border-gray-700 flex items-center justify-center overflow-hidden">
              <SpinningLogo src={Logo} alt="Altair" className="h-9 w-9 object-contain" />
            </div>
            <div className="bg-gray-800 p-3 rounded-2xl animate-pulse">
              <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="p-4 border-t border-gray-800 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
          placeholder="I want to swap 0.1 ETH for USDC..."
          className="flex-1 bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-2 text-sm outline-none focus:border-blue-500 transition-colors"
        />
        <button 
          onClick={handleSendMessage}
          disabled={isLoading}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 p-2 rounded-xl transition-all cursor-pointer"
        >
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
