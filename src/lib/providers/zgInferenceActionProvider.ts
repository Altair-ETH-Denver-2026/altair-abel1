/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ActionProvider,
  CreateAction,
  Network,
  EvmWalletProvider,
} from '@coinbase/agentkit';
import { z } from 'zod';
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';
import { Indexer } from '@0glabs/0g-ts-sdk';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const ZG_RPC_URL = process.env.ZG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
const ZG_PRIVATE_KEY = process.env.ZG_PRIVATE_KEY!;
const ZG_NETWORK = process.env.ZG_NETWORK || 'testnet';
const ZG_INDEXER_RPC =
  process.env.ZG_INDEXER_RPC || 'https://indexer-storage-testnet-turbo.0g.ai';
const ZG_LOCAL_FALLBACK_PATH =
  process.env.ZG_LOCAL_FALLBACK_PATH ?? path.join(process.cwd(), '.cache', 'zg-memory-fallback.json');
const ZG_LOCAL_INDEX_PATH =
  process.env.ZG_LOCAL_INDEX_PATH ?? path.join(process.cwd(), '.cache', 'zg-storage-index.json');

const ZgChatSchema = z.object({
  message: z.string().describe('The user message to send to decentralized AI.'),
  systemPrompt: z
    .string()
    .optional()
    .describe('Optional system prompt to set model behavior.'),
  userId: z
    .string()
    .optional()
    .describe('Optional Privy user ID for user-scoped memory namespace lookup.'),
  includeStoredChatContext: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to load and include latest stored chat context from 0G storage.'),
  providerAddress: z
    .string()
    .optional()
    .describe('Optional specific provider address; auto-selects chatbot provider if omitted.'),
});

const ZgListModelsSchema = z.object({
  serviceType: z
    .enum(['chatbot', 'text-to-image', 'speech-to-text'])
    .optional()
    .default('chatbot')
    .describe("Filter by service type. Defaults to 'chatbot'."),
});

const ZgAccountInfoSchema = z.object({});

const ZgSetupProviderSchema = z.object({
  providerAddress: z.string().describe('The 0G provider address to acknowledge and fund.'),
  depositAmount: z.number().optional().default(1).describe('0G amount to deposit in ledger.'),
  transferAmount: z
    .number()
    .optional()
    .default(1)
    .describe('0G amount to transfer to provider sub-account.'),
});

let brokerInstance: any = null;
let brokerInitPromise: Promise<any> | null = null;

function composeMemoryNamespace(address: string, userId?: string): string {
  const wallet = address.toLowerCase();
  const normalizedUserId = userId?.trim();
  if (!normalizedUserId) return wallet;
  return `privy:${normalizedUserId}:wallet:${wallet}`;
}

function memoryIndexKey(namespace: string, key: string): string {
  return `user:${namespace}:${key}`;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function downloadRootHash(rootHash: string): Promise<string> {
  const indexer = new Indexer(ZG_INDEXER_RPC);
  const outputPath = path.join(os.tmpdir(), `0g-inference-read-${Date.now()}.json`);
  const downloadErr = await indexer.download(rootHash, outputPath, true);
  if (downloadErr !== null) {
    throw new Error(`Error downloading from 0G Storage: ${downloadErr}`);
  }
  const content = await fs.readFile(outputPath, 'utf-8');
  await fs.unlink(outputPath).catch(() => undefined);
  return content;
}

async function readStoredChatSummary(namespace: string): Promise<{
  namespace: string;
  key: string;
  source: '0g_file' | 'local_file' | 'none';
  rootHash?: string;
  transactionHash?: string | null;
  value?: string;
  parsedValue?: Record<string, unknown> | null;
  warning?: string;
}> {
  const key = 'chat_summary_latest';
  const indexObj = await readJsonObject(ZG_LOCAL_INDEX_PATH);
  const memory = (indexObj?.memory ?? {}) as Record<
    string,
    { rootHash?: string; transactionHash?: string | null }
  >;
  const entry = memory[memoryIndexKey(namespace, key)];

  if (entry?.rootHash) {
    try {
      const raw = await downloadRootHash(entry.rootHash);
      let parsedOuter: Record<string, unknown> | null = null;
      let parsedValue: Record<string, unknown> | null = null;
      try {
        parsedOuter = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsedOuter.value === 'string') {
          try {
            parsedValue = JSON.parse(parsedOuter.value) as Record<string, unknown>;
          } catch {
            parsedValue = null;
          }
        }
      } catch {
        parsedOuter = null;
      }
      return {
        namespace,
        key,
        source: '0g_file',
        rootHash: entry.rootHash,
        transactionHash: entry.transactionHash ?? null,
        value: typeof parsedOuter?.value === 'string' ? parsedOuter.value : raw,
        parsedValue,
      };
    } catch (err: any) {
      const fallbackObj = await readJsonObject(ZG_LOCAL_FALLBACK_PATH);
      const fallbackValue = (fallbackObj ?? {})[memoryIndexKey(namespace, key)];
      if (typeof fallbackValue === 'string') {
        let parsedValue: Record<string, unknown> | null = null;
        try {
          parsedValue = JSON.parse(fallbackValue) as Record<string, unknown>;
        } catch {
          parsedValue = null;
        }
        return {
          namespace,
          key,
          source: 'local_file',
          value: fallbackValue,
          parsedValue,
          warning: `0G read failed, used fallback: ${err.message}`,
        };
      }
      return {
        namespace,
        key,
        source: 'none',
        warning: `0G read failed and no fallback found: ${err.message}`,
      };
    }
  }

  const fallbackObj = await readJsonObject(ZG_LOCAL_FALLBACK_PATH);
  const fallbackValue = (fallbackObj ?? {})[memoryIndexKey(namespace, key)];
  if (typeof fallbackValue === 'string') {
    let parsedValue: Record<string, unknown> | null = null;
    try {
      parsedValue = JSON.parse(fallbackValue) as Record<string, unknown>;
    } catch {
      parsedValue = null;
    }
    return {
      namespace,
      key,
      source: 'local_file',
      value: fallbackValue,
      parsedValue,
      warning: 'No indexed 0G entry found; using local fallback memory.',
    };
  }

  return { namespace, key, source: 'none', warning: 'No stored chat summary found for this namespace.' };
}

class ZgInferenceActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor() {
    super('zg-inference', []);
  }

  private async getBroker(): Promise<any> {
    if (brokerInstance) return brokerInstance;

    if (!brokerInitPromise) {
      brokerInitPromise = (async () => {
        if (!ZG_PRIVATE_KEY) {
          throw new Error(
            'ZG_PRIVATE_KEY is not set. Fund this wallet with 0G tokens before inference requests.'
          );
        }

        const provider = new ethers.JsonRpcProvider(ZG_RPC_URL);
        const wallet = new ethers.Wallet(ZG_PRIVATE_KEY, provider);
        brokerInstance = await createZGComputeNetworkBroker(wallet);
        return brokerInstance;
      })();
    }

    return brokerInitPromise;
  }

  @CreateAction({
    name: 'zg_inference_list_models',
    description: 'List available AI models on the 0G decentralized compute network.',
    schema: ZgListModelsSchema,
  })
  async listModels(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgListModelsSchema>
  ): Promise<string> {
    try {
      const broker = await this.getBroker();
      const services = await broker.inference.listService();

      const filtered = args.serviceType
        ? services.filter(
            (s: any) => s.serviceType?.toLowerCase() === args.serviceType?.toLowerCase()
          )
        : services;

      if (filtered.length === 0) {
        return JSON.stringify({
          status: 'no_models_found',
          serviceType: args.serviceType,
          network: ZG_NETWORK,
        });
      }

      const models = filtered.map((s: any) => ({
        provider: s.provider,
        model: s.model,
        serviceType: s.serviceType,
        inputPricePerMillionTokens: ethers.formatUnits(s.inputPrice || BigInt(0), 18),
        outputPricePerMillionTokens: ethers.formatUnits(s.outputPrice || BigInt(0), 18),
        verifiability: s.verifiability || 'none',
        url: s.url,
      }));

      return JSON.stringify(
        {
          status: 'models_listed',
          network: ZG_NETWORK,
          count: models.length,
          models,
        },
        null,
        2
      );
    } catch (err: any) {
      return `Error listing models: ${err.message}`;
    }
  }

  @CreateAction({
    name: 'zg_inference_setup_provider',
    description: 'One-time setup for a 0G inference provider.',
    schema: ZgSetupProviderSchema,
  })
  async setupProvider(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgSetupProviderSchema>
  ): Promise<string> {
    try {
      const broker = await this.getBroker();

      try {
        await broker.ledger.getLedger();
        if (args.depositAmount > 0) await broker.ledger.depositFund(args.depositAmount);
      } catch {
        const initialDeposit = Math.max(args.depositAmount, 3);
        await broker.ledger.addLedger(initialDeposit);
      }

      await broker.inference.acknowledgeProviderSigner(args.providerAddress);

      if (args.transferAmount > 0) {
        const transferWei = ethers.parseEther(args.transferAmount.toString());
        await broker.ledger.transferFund(args.providerAddress, 'inference', transferWei);
      }

      return JSON.stringify(
        {
          status: 'provider_setup_complete',
          providerAddress: args.providerAddress,
          deposited: `${args.depositAmount} 0G`,
          transferred: `${args.transferAmount} 0G`,
        },
        null,
        2
      );
    } catch (err: any) {
      return `Error setting up provider: ${err.message}`;
    }
  }

  @CreateAction({
    name: 'zg_inference_account_info',
    description: 'Check your 0G compute account state and balance.',
    schema: ZgAccountInfoSchema,
  })
  async accountInfo(
    _walletProvider: EvmWalletProvider,
    _args: z.infer<typeof ZgAccountInfoSchema>
  ): Promise<string> {
    void _walletProvider;
    void _args;
    try {
      const broker = await this.getBroker();
      const provider = new ethers.JsonRpcProvider(ZG_RPC_URL);
      const wallet = new ethers.Wallet(ZG_PRIVATE_KEY, provider);

      const balance = await provider.getBalance(wallet.address);

      let ledgerInfo: any = null;
      try {
        ledgerInfo = await broker.ledger.getLedger();
      } catch {}

      return JSON.stringify(
        {
          status: 'account_info',
          network: ZG_NETWORK,
          walletAddress: wallet.address,
          nativeBalance: `${ethers.formatEther(balance)} 0G`,
          ledger: ledgerInfo
            ? {
                exists: true,
                raw: JSON.parse(
                  JSON.stringify(ledgerInfo, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
                ),
              }
            : { exists: false, message: 'Run zg_inference_setup_provider first' },
        },
        null,
        2
      );
    } catch (err: any) {
      return `Error getting account info: ${err.message}`;
    }
  }

  @CreateAction({
    name: 'zg_inference_chat',
    description: 'Send a message to 0G decentralized AI with optional TEE verification.',
    schema: ZgChatSchema,
  })
  async chat(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgChatSchema>
  ): Promise<string> {
    try {
      const broker = await this.getBroker();
      const walletAddress = await walletProvider.getAddress();
      const namespace = composeMemoryNamespace(walletAddress, args.userId);
      const storedChatContext = args.includeStoredChatContext
        ? await readStoredChatSummary(namespace)
        : null;
      if (storedChatContext) {
        console.log(
          '[zg-inference] loaded stored chat context',
          JSON.stringify(
            {
              namespace: storedChatContext.namespace,
              source: storedChatContext.source,
              rootHash: storedChatContext.rootHash ?? null,
              hasValue: Boolean(storedChatContext.value),
            },
            null,
            2
          )
        );
      }
      let providerAddress = args.providerAddress;

      if (!providerAddress) {
        const services = await broker.inference.listService();
        const chatServices = services.filter(
          (s: any) => s.serviceType?.toLowerCase() === 'chatbot'
        );
        if (chatServices.length === 0) {
          return JSON.stringify({
            status: 'error',
            message: `No chatbot providers found on ${ZG_NETWORK}`,
          });
        }
        providerAddress = chatServices[0].provider;
      }

      const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
      const messages: Array<{ role: string; content: string }> = [];

      if (args.systemPrompt) {
        messages.push({ role: 'system', content: args.systemPrompt });
      }
      messages.push({ role: 'user', content: args.message });

      const requestBody = JSON.stringify({ messages, model });
      const headers = await broker.inference.getRequestHeaders(providerAddress, requestBody);

      const response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: requestBody,
      });

      if (!response.ok) {
        const errText = await response.text();
        return JSON.stringify({
          status: 'error',
          httpStatus: response.status,
          message: errText,
          provider: providerAddress,
          model,
        });
      }

      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content || 'No response content';

      const chatID =
        response.headers.get('ZG-Res-Key') ||
        response.headers.get('zg-res-key') ||
        data.id ||
        data.chatID;

      let verified = false;
      try {
        if (chatID && data.usage) {
          verified = await broker.inference.processResponse(
            providerAddress,
            chatID,
            JSON.stringify(data.usage)
          );
        } else if (data.usage) {
          await broker.inference.processResponse(
            providerAddress,
            undefined,
            JSON.stringify(data.usage)
          );
        }
      } catch (verifyErr: any) {
        console.warn('0G response verification warning:', verifyErr.message);
      }

      return JSON.stringify(
        {
          status: 'inference_complete',
          network: ZG_NETWORK,
          namespace,
          userId: args.userId ?? null,
          walletAddress: walletAddress.toLowerCase(),
          storedChatContext,
          provider: providerAddress,
          model,
          response: answer,
          usage: data.usage || null,
          teeVerified: verified,
          teeAttestation: chatID || null,
        },
        null,
        2
      );
    } catch (err: any) {
      return `Inference error: ${err.message}`;
    }
  }

  supportsNetwork = (_network: Network): boolean => {
    void _network;
    return true;
  };
}

export const zgInferenceActionProvider = () => new ZgInferenceActionProvider();
