import { NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function tokenAddressFromSymbol(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === 'ETH') return '0x0000000000000000000000000000000000000000';
  if (normalized === 'WETH') return '0x4200000000000000000000000000000000000006';
  if (normalized === 'USDC') return '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  if (normalized === 'DAI') return '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';
  if (normalized === 'CBBTC') return '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
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

export async function POST(req: Request) {
  try {
    const { message, history, accessToken } = await req.json();

    const systemPrompt = `
      You are Altair, a DeFi concierge on the Base network. 
      Identify: Sell Token, Buy Token, and Amount.
      If info is missing, ask. If ready, return JSON:
      { "type": "SWAP_INTENT", "sell": "ETH", "buy": "USDC", "amount": 0.1 }
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
        baseRpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
      });
      return actions as unknown as ActionLike[];
    };

    const findAction = (actions: ActionLike[], name: string): ActionLike | undefined =>
      actions.find((a) => a.name === name);

    // Attempt to execute swap intent with AgentKit tools if model returned JSON.
    const trimmed = aiResponse.trim();
    const looksLikeJson = trimmed.startsWith('{') && trimmed.endsWith('}');
    if (looksLikeJson) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === 'SWAP_INTENT') {
          if (!accessToken) {
            executionNote = 'Swap intent detected, but user is not authenticated. Please connect/sign in first.';
          } else {
            const actions = await getActions();

            const sell = String(parsed.sell ?? '');
            const buy = String(parsed.buy ?? '');
            const amount = Number(parsed.amount);
            if (!sell || !buy || !Number.isFinite(amount) || amount <= 0) {
              throw new Error('SWAP_INTENT is missing valid sell/buy/amount fields');
            }

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
            executionNote = `Swap tool executed for ${amount} ${sell} -> ${buy}.\n${String(result)}`;
          }
        }
      } catch (intentErr) {
        // If parsing fails, we just return the AI text; log server-side
        console.warn('Swap intent parse/exec skipped:', intentErr);
      }
    }

    // Automatically persist chat and trade context to 0G per-user memory.
    if (accessToken) {
      try {
        const actions = await getActions();
        const saveMemoryAction = findAction(actions, 'zg_storage_save_memory');
        if (!saveMemoryAction) {
          throw new Error('zg_storage_save_memory action not registered');
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

    return NextResponse.json({
      content: executionNote ? `${executionNote}\n\n${aiResponse}` : aiResponse,
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
