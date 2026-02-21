import { NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function tokenAddressFromSymbol(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === 'ETH') return '0x0000000000000000000000000000000000000000';
  if (normalized === 'WETH') return '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
  if (normalized === 'USDC') return '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
  if (normalized === 'DAI') return '0x68194a729c2450ad26072b3d33adacbcef39d574';
  return null;
}

function toSmallestUnit(amount: number, symbol: string): string {
  const decimals = symbol.trim().toUpperCase() === 'USDC' ? 6 : 18;
  const scaled = Math.floor(amount * 10 ** decimals);
  return String(scaled);
}

type ActionLike = {
  name?: string;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
};

type SwapIntent = {
  amount: number;
  sell: string;
  buy: string;
};
const pendingSwapBySession = new Map<string, SwapIntent>();

function extractSwapIntentFromMessage(message: string): SwapIntent | null {
  const match = message.match(
    /\bswap\s+([0-9]*\.?[0-9]+)\s*([a-zA-Z]+)\s+(?:for|to|into)\s+([a-zA-Z]+)/i
  );
  if (!match) return null;

  const amount = Number(match[1]);
  const sell = String(match[2]).toUpperCase();
  const buy = String(match[3]).toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, sell, buy };
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function extractTxHash(value: unknown): string | null {
  const parsed = toObject(value);
  const txHash = parsed?.transactionHash;
  return typeof txHash === 'string' ? txHash : null;
}

function sanitizeAssistantReply(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').trim();
}

function isSwapConfirmationMessage(message: string): boolean {
  return /\b(yes|confirm|proceed|go ahead|do it|execute|run swap)\b/i.test(message);
}

export async function POST(req: Request) {
  try {
    const { message, history, accessToken } = await req.json();

    const systemPrompt = `
      You are Altair, a DeFi concierge on Ethereum Sepolia testnet.
      Reply in plain English only.
      Never output JSON, code blocks, or schema-like responses.
      If the user asks for a swap and details are missing, ask a short clarifying question.
    `;

    // Actual OpenAI Call
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message },
      ],
    });

    const aiResponse = response.choices[0].message.content || '';

    const executionNote: string | null = null;
    let swapRecord: Record<string, unknown> | null = null;
    let zgTxHash: string | null = null;
    let zgError: string | null = null;
    let forcedResponse: string | null = null;
    const sessionKey = accessToken ?? 'anonymous';

    const getActions = async (): Promise<ActionLike[]> => {
      if (!accessToken) return [];
      const { createAgent } = await import('@/lib/setup');
      const { actions } = await createAgent({
        accessToken,
        evmRpcUrl:
          process.env.ETH_SEPOLIA_RPC_URL
          ?? 'https://ethereum-sepolia-rpc.publicnode.com',
      });
      return actions as unknown as ActionLike[];
    };

    const findAction = (actions: ActionLike[], name: string): ActionLike | undefined =>
      actions.find((a) => a.name === name);
    const findQuoteAction = (actions: ActionLike[]): ActionLike | undefined =>
      findAction(actions, 'uniswap_get_quote')
      ?? actions.find((a) => a.name?.toLowerCase().includes('quote'));
    const findSwapAction = (actions: ActionLike[]): ActionLike | undefined =>
      findAction(actions, 'uniswap_swap')
      ?? actions.find((a) => a.name?.toLowerCase().includes('swap'));

    const findStorageSaveAction = (actions: ActionLike[]): ActionLike | undefined =>
      findAction(actions, 'zg_storage_save_memory')
      ?? actions.find((a) => a.name?.toLowerCase().includes('save_memory'))
      ?? actions.find((a) => a.name?.toLowerCase().includes('zg_storage'));

    // Step 1: quote when swap intent appears.
    const swapIntent = extractSwapIntentFromMessage(message);
    if (swapIntent) {
      try {
        if (!accessToken) {
          forcedResponse = 'I can prepare that swap, but please connect/sign in first so I can quote and execute it.';
        } else {
          const actions = await getActions();
          const { amount, sell, buy } = swapIntent;

          const tokenIn = tokenAddressFromSymbol(sell);
          const tokenOut = tokenAddressFromSymbol(buy);
          if (!tokenIn || !tokenOut) {
            throw new Error(`Unsupported token symbol pair: ${sell} -> ${buy}`);
          }

          const uniswapQuoteAction = findQuoteAction(actions);
          if (!uniswapQuoteAction) {
            const available = actions.map((a) => a.name ?? '(unnamed)').join(', ');
            throw new Error(`uniswap_get_quote action not registered. Available actions: ${available}`);
          }

          const quoteResult = await uniswapQuoteAction.invoke({
            tokenIn,
            tokenOut,
            amount: toSmallestUnit(amount, sell),
            slippageTolerance: 0.5,
          });
          const quoteObj = toObject(quoteResult);
          const amountOut =
            quoteObj?.amountOut
            ?? quoteObj?.quoteAmountOut
            ?? quoteObj?.expectedAmountOut
            ?? 'unknown';
          pendingSwapBySession.set(sessionKey, { amount, sell, buy });

          forcedResponse =
            `Estimated quote for swapping ${amount} ${sell} -> ${buy} on Ethereum Sepolia is ` +
            `${amountOut} ${buy} (subject to slippage/market movement). ` +
            `Reply "confirm swap" to proceed.`;
        }
      } catch (intentErr) {
        console.warn('Swap quote flow failed:', intentErr);
        forcedResponse =
          intentErr instanceof Error
            ? `I could not fetch a swap quote right now: ${intentErr.message}`
            : 'I could not fetch a swap quote right now.';
      }
    }

    // Step 2: execute pending swap on explicit confirmation.
    if (!swapIntent && isSwapConfirmationMessage(message) && accessToken) {
      const pending = pendingSwapBySession.get(sessionKey);
      if (pending) {
        try {
          const actions = await getActions();
          const tokenIn = tokenAddressFromSymbol(pending.sell);
          const tokenOut = tokenAddressFromSymbol(pending.buy);
          if (!tokenIn || !tokenOut) {
            throw new Error(`Unsupported token symbol pair: ${pending.sell} -> ${pending.buy}`);
          }

          const uniswapSwapAction = findSwapAction(actions);
          if (!uniswapSwapAction) {
            const available = actions.map((a) => a.name ?? '(unnamed)').join(', ');
            throw new Error(`uniswap_swap action not registered. Available actions: ${available}`);
          }

          const result = await uniswapSwapAction.invoke({
            tokenIn,
            tokenOut,
            amount: toSmallestUnit(pending.amount, pending.sell),
            slippageTolerance: 0.5,
          });
          pendingSwapBySession.delete(sessionKey);

          swapRecord = {
            sell: pending.sell,
            buy: pending.buy,
            amount: pending.amount,
            tokenIn,
            tokenOut,
            result,
            createdAt: new Date().toISOString(),
          };
          const swapTx = extractTxHash(result);
          forcedResponse = swapTx
            ? `Swap submitted on Ethereum Sepolia for ${pending.amount} ${pending.sell} -> ${pending.buy}. Tx: ${swapTx}`
            : `Swap submitted on Ethereum Sepolia for ${pending.amount} ${pending.sell} -> ${pending.buy}.`;
        } catch (swapErr) {
          console.warn('Swap execution failed:', swapErr);
          forcedResponse =
            swapErr instanceof Error
              ? `I could not execute the swap: ${swapErr.message}`
              : 'I could not execute the swap right now.';
        }
      } else {
        forcedResponse = 'I do not have a pending quote to execute. Ask me for a fresh swap quote first.';
      }
    }

    // Automatically persist chat and trade context to 0G per-user memory.
    if (accessToken) {
      try {
        const actions = await getActions();
        const saveMemoryAction = findStorageSaveAction(actions);
        if (!saveMemoryAction) {
          const available = actions.map((a) => a.name ?? '(unnamed)').join(', ');
          throw new Error(`zg_storage_save_memory action not registered. Available actions: ${available}`);
        }

        const summaryResult = await saveMemoryAction.invoke({
          key: 'chat_summary_latest',
          value: JSON.stringify({
            userMessage: message,
            aiResponse: forcedResponse ?? aiResponse,
            hadSwapExecution: Boolean(swapRecord),
            updatedAt: new Date().toISOString(),
          }),
        });
        zgTxHash = extractTxHash(summaryResult) ?? zgTxHash;

        if (swapRecord) {
          const tradeResult = await saveMemoryAction.invoke({
            key: `trade_${Date.now()}`,
            value: JSON.stringify(swapRecord),
          });
          zgTxHash = extractTxHash(tradeResult) ?? zgTxHash;
        }
      } catch (storageErr) {
        zgError =
          storageErr instanceof Error
            ? storageErr.message
            : 'Failed to automatically store chat/swap data to 0G';
        console.warn('0G auto-memory save failed:', storageErr);
      }
    }

    const cleanedReply = sanitizeAssistantReply(forcedResponse ?? aiResponse);
    return NextResponse.json({
      content: executionNote ? `${executionNote}\n\n${cleanedReply}` : cleanedReply,
      zgHash: zgTxHash,
      txHash: zgTxHash,
      zgError,
    });
  } catch (error) {
    console.error('Chat Error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
