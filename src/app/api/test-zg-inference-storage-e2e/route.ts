import { NextResponse } from 'next/server';
import { zgStorageActionProvider } from '@/lib/providers/zgStorageActionProvider';
import { zgInferenceActionProvider } from '@/lib/providers/zgInferenceActionProvider';

type WalletLike = {
  getAddress: () => Promise<string>;
};

function parseResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      return { raw: value };
    }
  }
  return null;
}

export async function GET() {
  try {
    const userId = `did:e2e:${Date.now()}`;
    const walletAddress =
      process.env.ZG_ADDRESS
      ?? '0xA7b35a68E8Dcaf78624896372b3B20ba1654E5D5';
    const walletProvider: WalletLike = {
      getAddress: async () => walletAddress,
    };

    const storage = zgStorageActionProvider() as unknown as {
      saveMemory: (wallet: WalletLike, args: Record<string, unknown>) => Promise<string>;
    };
    const inference = zgInferenceActionProvider() as unknown as {
      listModels: (wallet: WalletLike, args: Record<string, unknown>) => Promise<string>;
      setupProvider: (wallet: WalletLike, args: Record<string, unknown>) => Promise<string>;
      chat: (wallet: WalletLike, args: Record<string, unknown>) => Promise<string>;
    };

    const summaryPayload = {
      userMessage: 'e2e: summarize my prior chat',
      aiResponse: 'e2e: this is a stored chat summary used for inference context',
      hadSwapExecution: false,
      updatedAt: new Date().toISOString(),
    };

    const writeRaw = await storage.saveMemory(walletProvider, {
      key: 'chat_summary_latest',
      userId,
      value: JSON.stringify(summaryPayload),
    });
    const write = parseResult(writeRaw);

    const modelsRaw = await inference.listModels(walletProvider, { serviceType: 'chatbot' });
    const models = parseResult(modelsRaw);
    const firstProvider =
      (models?.models as Array<{ provider?: string }> | undefined)?.find((m) => typeof m.provider === 'string')
        ?.provider ?? null;

    let setup = null as Record<string, unknown> | null;
    if (firstProvider) {
      const setupRaw = await inference.setupProvider(walletProvider, {
        providerAddress: firstProvider,
        depositAmount: 0,
        transferAmount: 0,
      });
      setup = parseResult(setupRaw);
    }

    const inferenceRaw = await inference.chat(walletProvider, {
      message: 'Use my stored chat summary as context and acknowledge it briefly.',
      userId,
      includeStoredChatContext: true,
      providerAddress: firstProvider ?? undefined,
    });
    const inferenceResult = parseResult(inferenceRaw);
    const storedChatContext = inferenceResult?.storedChatContext ?? null;

    return NextResponse.json({
      ok: true,
      userId,
      walletAddress: walletAddress.toLowerCase(),
      write,
      models: {
        count: Array.isArray(models?.models) ? models?.models.length : 0,
        firstProvider,
      },
      setup,
      inference: inferenceResult,
      storedChatContext,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

