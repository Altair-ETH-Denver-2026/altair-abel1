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

    let executionNote: string | null = null;
    let swapRecord: Record<string, unknown> | null = null;
    let zgTxHash: string | null = null;
    let zgError: string | null = null;

    const getActions = async (): Promise<ActionLike[]> => {
      if (!accessToken) return [];
      const { createAgent } = await import('@/lib/setup');
      const { actions } = await createAgent({
        accessToken,
        evmRpcUrl:
          process.env.ETH_SEPOLIA_RPC_URL
          ?? process.env.BASE_SEPOLIA_RPC_URL
          ?? 'https://ethereum-sepolia-rpc.publicnode.com',
      });
      return actions as unknown as ActionLike[];
    };

    const findAction = (actions: ActionLike[], name: string): ActionLike | undefined =>
      actions.find((a) => a.name === name);

    const findStorageSaveAction = (actions: ActionLike[]): ActionLike | undefined =>
      findAction(actions, 'zg_storage_save_memory')
      ?? actions.find((a) => a.name?.toLowerCase().includes('save_memory'))
      ?? actions.find((a) => a.name?.toLowerCase().includes('zg_storage'));

    // Attempt to execute swap intent based on user message.
    const swapIntent = extractSwapIntentFromMessage(message);
    if (swapIntent) {
      try {
        if (!accessToken) {
          executionNote = 'Swap intent detected, but user is not authenticated. Please connect/sign in first.';
        } else {
          const actions = await getActions();
          const { amount, sell, buy } = swapIntent;

          const tokenIn = tokenAddressFromSymbol(sell);
          const tokenOut = tokenAddressFromSymbol(buy);
          if (!tokenIn || !tokenOut) {
            throw new Error(`Unsupported token symbol pair: ${sell} -> ${buy}`);
          }

          const uniswapSwapAction = findAction(actions, 'uniswap_swap');
          if (!uniswapSwapAction) {
            throw new Error('uniswap_swap action not registered');
          }

          const result = await uniswapSwapAction.invoke({
            tokenIn,
            tokenOut,
            amount: toSmallestUnit(amount, sell),
            slippageTolerance: 0.5,
          });

          swapRecord = {
            sell,
            buy,
            amount,
            tokenIn,
            tokenOut,
            result,
            createdAt: new Date().toISOString(),
          };
          const swapTx = extractTxHash(result);
          executionNote = swapTx
            ? `Swap submitted on Ethereum Sepolia for ${amount} ${sell} -> ${buy}. Tx: ${swapTx}`
            : `Swap submitted on Ethereum Sepolia for ${amount} ${sell} -> ${buy}.`;
        }
      } catch (intentErr) {
        console.warn('Swap intent parse/exec skipped:', intentErr);
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
            aiResponse,
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

    const cleanedReply = sanitizeAssistantReply(aiResponse);
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
