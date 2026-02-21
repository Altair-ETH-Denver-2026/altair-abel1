/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ActionProvider,
  CreateAction,
  Network,
  EvmWalletProvider,
} from '@coinbase/agentkit';
import { z } from 'zod';
import { ethers } from 'ethers';
import { Indexer, ZgFile } from '@0glabs/0g-ts-sdk';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const ZG_RPC_URL = process.env.ZG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
const ZG_PRIVATE_KEY = process.env.ZG_PRIVATE_KEY!;
const ZG_INDEXER_RPC =
  process.env.ZG_INDEXER_RPC || 'https://indexer-storage-testnet-turbo.0g.ai';
const ZG_NETWORK = process.env.ZG_NETWORK || 'testnet';
const ZG_ENABLE_LOCAL_FALLBACK = (process.env.ZG_ENABLE_LOCAL_FALLBACK ?? 'true') === 'true';
const ZG_LOCAL_FALLBACK_PATH =
  process.env.ZG_LOCAL_FALLBACK_PATH ?? path.join(process.cwd(), '.cache', 'zg-memory-fallback.json');
const ZG_LOCAL_INDEX_PATH =
  process.env.ZG_LOCAL_INDEX_PATH ?? path.join(process.cwd(), '.cache', 'zg-storage-index.json');

const ZgSaveMemorySchema = z.object({
  key: z.string().describe('Memory key, e.g. preferences or risk_tolerance.'),
  value: z.string().describe('JSON string content for this memory key.'),
  userAddress: z.string().optional().describe("Optional user address; defaults to connected wallet's."),
});

const ZgGetMemorySchema = z.object({
  key: z.string().describe('Memory key to retrieve.'),
  userAddress: z.string().optional().describe('Optional wallet namespace override.'),
});

const ZgUploadKnowledgeSchema = z.object({
  content: z.string().describe('Knowledge document content to upload as file.'),
  label: z.string().describe('Human-readable lookup label.'),
});

const ZgGetKnowledgeSchema = z.object({
  label: z.string().describe('Knowledge label to fetch.'),
});

function getEthersSigner(): ethers.Wallet {
  if (!ZG_PRIVATE_KEY) {
    throw new Error(
      'ZG_PRIVATE_KEY is not set. This wallet must hold 0G tokens for storage operations.'
    );
  }
  const provider = new ethers.JsonRpcProvider(ZG_RPC_URL);
  return new ethers.Wallet(ZG_PRIVATE_KEY, provider);
}

function localFallbackMemoryKey(address: string, key: string): string {
  return `user:${address.toLowerCase()}:${key}`;
}

async function loadLocalFallbackStore(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(ZG_LOCAL_FALLBACK_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

async function writeLocalFallbackValue(
  address: string,
  key: string,
  value: string
): Promise<void> {
  const store = await loadLocalFallbackStore();
  store[localFallbackMemoryKey(address, key)] = value;
  await fs.mkdir(path.dirname(ZG_LOCAL_FALLBACK_PATH), { recursive: true });
  await fs.writeFile(ZG_LOCAL_FALLBACK_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

async function readLocalFallbackValue(address: string, key: string): Promise<string | null> {
  const store = await loadLocalFallbackStore();
  return store[localFallbackMemoryKey(address, key)] ?? null;
}

type StorageIndex = {
  memory: Record<string, { rootHash: string; transactionHash: string | null; updatedAt: string }>;
  knowledge: Record<string, { rootHash: string; transactionHash: string | null; updatedAt: string }>;
};

function emptyIndex(): StorageIndex {
  return { memory: {}, knowledge: {} };
}

async function loadIndex(): Promise<StorageIndex> {
  try {
    const raw = await fs.readFile(ZG_LOCAL_INDEX_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.memory === 'object' &&
      typeof parsed.knowledge === 'object'
    ) {
      return parsed as StorageIndex;
    }
    return emptyIndex();
  } catch {
    return emptyIndex();
  }
}

async function saveIndex(index: StorageIndex): Promise<void> {
  await fs.mkdir(path.dirname(ZG_LOCAL_INDEX_PATH), { recursive: true });
  await fs.writeFile(ZG_LOCAL_INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
}

function extractTxHash(tx: unknown): string | null {
  if (typeof tx === 'string') return tx;
  if (typeof tx === 'object' && tx !== null) {
    const maybe = tx as { txHash?: string; transactionHash?: string };
    return maybe.txHash ?? maybe.transactionHash ?? null;
  }
  return null;
}

async function uploadContentTo0g(content: string, namePrefix: string): Promise<{
  rootHash: string;
  transactionHash: string | null;
}> {
  const signer = getEthersSigner();
  const indexer = new Indexer(ZG_INDEXER_RPC);
  const tmpFile = path.join(os.tmpdir(), `${namePrefix}-${Date.now()}.json`);
  await fs.writeFile(tmpFile, content, 'utf-8');
  const file = await ZgFile.fromFilePath(tmpFile);
  const [tree, treeErr] = await file.merkleTree();
  if (treeErr !== null || !tree) {
    await file.close();
    await fs.unlink(tmpFile).catch(() => undefined);
    throw new Error(`Error computing Merkle tree: ${treeErr}`);
  }
  const rootHash = tree.rootHash();
  const [tx, uploadErr] = await indexer.upload(file, ZG_RPC_URL, signer as any);
  await file.close();
  await fs.unlink(tmpFile).catch(() => undefined);
  if (uploadErr !== null) {
    throw new Error(`Error uploading to 0G Storage: ${uploadErr}`);
  }
  return { rootHash, transactionHash: extractTxHash(tx) };
}

async function downloadContentFrom0g(rootHash: string): Promise<string> {
  const indexer = new Indexer(ZG_INDEXER_RPC);
  const outputPath = path.join(os.tmpdir(), `0g-read-${Date.now()}.json`);
  const downloadErr = await indexer.download(rootHash, outputPath, true);
  if (downloadErr !== null) {
    throw new Error(`Error downloading from 0G Storage: ${downloadErr}`);
  }
  const content = await fs.readFile(outputPath, 'utf-8');
  await fs.unlink(outputPath).catch(() => undefined);
  return content;
}

class ZgStorageActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor() {
    super('zg-storage', []);
  }

  @CreateAction({
    name: 'zg_storage_save_memory',
    description: 'Save user-scoped memory to 0G file storage (no KV dependency).',
    schema: ZgSaveMemorySchema,
  })
  async saveMemory(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgSaveMemorySchema>
  ): Promise<string> {
    const address = args.userAddress || (await walletProvider.getAddress());
    try {
      const payload = JSON.stringify(
        {
          kind: 'memory',
          namespace: address.toLowerCase(),
          key: args.key,
          value: args.value,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      );
      const { rootHash, transactionHash } = await uploadContentTo0g(
        payload,
        `0g-memory-${address.toLowerCase()}-${args.key}`
      );
      const index = await loadIndex();
      index.memory[localFallbackMemoryKey(address, args.key)] = {
        rootHash,
        transactionHash,
        updatedAt: new Date().toISOString(),
      };
      await saveIndex(index);

      return JSON.stringify(
        {
          status: 'memory_saved',
          network: ZG_NETWORK,
          key: args.key,
          namespace: address.toLowerCase(),
          rootHash,
          transactionHash,
          valueSizeBytes: Buffer.byteLength(args.value, 'utf-8'),
          backend: '0g_file',
        },
        null,
        2
      );
    } catch (err: any) {
      if (ZG_ENABLE_LOCAL_FALLBACK) {
        await writeLocalFallbackValue(address, args.key, args.value);
        return JSON.stringify(
          {
            status: 'memory_saved_fallback',
            backend: 'local_file',
            key: args.key,
            namespace: address.toLowerCase(),
            fallbackPath: ZG_LOCAL_FALLBACK_PATH,
            warning: `0G write failed: ${err.message}`,
          },
          null,
          2
        );
      }
      return `Error saving memory: ${err.message}`;
    }
  }

  @CreateAction({
    name: 'zg_storage_get_memory',
    description: 'Retrieve user-scoped memory from 0G file storage (no KV dependency).',
    schema: ZgGetMemorySchema,
  })
  async getMemory(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgGetMemorySchema>
  ): Promise<string> {
    const address = args.userAddress || (await walletProvider.getAddress());
    try {
      const index = await loadIndex();
      const entry = index.memory[localFallbackMemoryKey(address, args.key)];
      if (!entry) {
        if (ZG_ENABLE_LOCAL_FALLBACK) {
          const fallbackValue = await readLocalFallbackValue(address, args.key);
          if (fallbackValue !== null) {
            return JSON.stringify({
              status: 'memory_retrieved',
              network: ZG_NETWORK,
              key: args.key,
              namespace: address.toLowerCase(),
              backend: 'local_file',
              fallbackPath: ZG_LOCAL_FALLBACK_PATH,
              value: fallbackValue,
            });
          }
        }
        return JSON.stringify({
          status: 'not_found',
          key: args.key,
          namespace: address.toLowerCase(),
        });
      }
      const raw = await downloadContentFrom0g(entry.rootHash);
      let value = raw;
      try {
        const parsed = JSON.parse(raw) as { value?: string };
        if (typeof parsed.value === 'string') value = parsed.value;
      } catch {
        // Keep raw content as value.
      }
      return JSON.stringify(
        {
          status: 'memory_retrieved',
          network: ZG_NETWORK,
          key: args.key,
          namespace: address.toLowerCase(),
          rootHash: entry.rootHash,
          transactionHash: entry.transactionHash,
          value,
          backend: '0g_file',
        },
        null,
        2
      );
    } catch (err: any) {
      if (ZG_ENABLE_LOCAL_FALLBACK) {
        const fallbackValue = await readLocalFallbackValue(address, args.key);
        if (fallbackValue !== null) {
          return JSON.stringify(
            {
              status: 'memory_retrieved',
              network: ZG_NETWORK,
              key: args.key,
              namespace: address.toLowerCase(),
              backend: 'local_file',
              fallbackPath: ZG_LOCAL_FALLBACK_PATH,
              warning: `0G file read failed: ${err.message}`,
              value: fallbackValue,
            },
            null,
            2
          );
        }
      }
      if (err.message?.includes('not found') || err.message?.includes('null')) {
        return JSON.stringify({ status: 'not_found', key: args.key });
      }
      return `Error retrieving memory: ${err.message}`;
    }
  }

  @CreateAction({
    name: 'zg_storage_upload_knowledge',
    description: 'Upload a knowledge document to 0G file storage (no KV dependency).',
    schema: ZgUploadKnowledgeSchema,
  })
  async uploadKnowledge(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgUploadKnowledgeSchema>
  ): Promise<string> {
    try {
      const payload = JSON.stringify(
        {
          kind: 'knowledge',
          label: args.label,
          content: args.content,
          uploadedAt: new Date().toISOString(),
        },
        null,
        2
      );
      const { rootHash, transactionHash } = await uploadContentTo0g(
        payload,
        `0g-kb-${args.label}`
      );
      const index = await loadIndex();
      index.knowledge[args.label] = {
        rootHash,
        transactionHash,
        updatedAt: new Date().toISOString(),
      };
      await saveIndex(index);

      return JSON.stringify(
        {
          status: 'knowledge_uploaded',
          network: ZG_NETWORK,
          label: args.label,
          rootHash,
          transactionHash,
          contentLength: args.content.length,
          backend: '0g_file',
        },
        null,
        2
      );
    } catch (err: any) {
      return `Error uploading knowledge: ${err.message}`;
    }
  }

  @CreateAction({
    name: 'zg_storage_get_knowledge',
    description: 'Retrieve a knowledge document by label from 0G file storage (no KV dependency).',
    schema: ZgGetKnowledgeSchema,
  })
  async getKnowledge(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgGetKnowledgeSchema>
  ): Promise<string> {
    try {
      const index = await loadIndex();
      const indexEntry = index.knowledge[args.label];
      if (!indexEntry) {
        return JSON.stringify({ status: 'not_found', label: args.label });
      }
      const raw = await downloadContentFrom0g(indexEntry.rootHash);
      let content = raw;
      let uploadedAt: string | undefined = indexEntry.updatedAt;
      try {
        const parsed = JSON.parse(raw) as { content?: string; uploadedAt?: string };
        if (typeof parsed.content === 'string') content = parsed.content;
        if (typeof parsed.uploadedAt === 'string') uploadedAt = parsed.uploadedAt;
      } catch {
        // Keep raw content.
      }

      return JSON.stringify(
        {
          status: 'knowledge_retrieved',
          network: ZG_NETWORK,
          label: args.label,
          rootHash: indexEntry.rootHash,
          uploadedAt,
          transactionHash: indexEntry.transactionHash,
          content,
          verified: true,
          backend: '0g_file',
        },
        null,
        2
      );
    } catch (err: any) {
      return `Error retrieving knowledge: ${err.message}`;
    }
  }

  supportsNetwork = (_network: Network): boolean => {
    void _network;
    return true;
  };
}

export const zgStorageActionProvider = () => new ZgStorageActionProvider();
