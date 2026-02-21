/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ActionProvider,
  CreateAction,
  Network,
  EvmWalletProvider,
} from '@coinbase/agentkit';
import { z } from 'zod';
import { ethers } from 'ethers';
import { Indexer, ZgFile, Batcher, KvClient, getFlowContract } from '@0glabs/0g-ts-sdk';

const ZG_RPC_URL = process.env.ZG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
const ZG_PRIVATE_KEY = process.env.ZG_PRIVATE_KEY!;
const ZG_INDEXER_RPC =
  process.env.ZG_INDEXER_RPC || 'https://indexer-storage-testnet-standard.0g.ai';
const ZG_KV_RPC = process.env.ZG_KV_RPC || 'http://3.101.147.150:6789';
const ZG_FLOW_CONTRACT =
  process.env.ZG_FLOW_CONTRACT || '0x22E03a6A89B950F1c82ec5e74F8eCa321a105296';
const ZG_STREAM_ID =
  process.env.ZG_STREAM_ID ||
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const ZG_NETWORK = process.env.ZG_NETWORK || 'testnet';
const ZG_KV_RPC_FALLBACKS = (process.env.ZG_KV_RPC_FALLBACKS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ZG_KV_TIMEOUT_MS = Number(process.env.ZG_KV_TIMEOUT_MS ?? 5000);

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

function userKey(address: string, key: string): Uint8Array {
  const fullKey = `user:${address.toLowerCase()}:${key}`;
  return Uint8Array.from(Buffer.from(fullKey, 'utf-8'));
}

function kbIndexKey(label: string): Uint8Array {
  return Uint8Array.from(Buffer.from(`kb:${label}`, 'utf-8'));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

async function readKvValueWithFallback(
  streamId: string,
  key: Uint8Array
): Promise<{ value: Awaited<ReturnType<KvClient['getValue']>>; endpoint: string }> {
  const endpoints = [ZG_KV_RPC, ...ZG_KV_RPC_FALLBACKS];
  let lastErr: unknown = null;

  for (const endpoint of endpoints) {
    try {
      const kvClient = new KvClient(endpoint);
      const value = await withTimeout(kvClient.getValue(streamId, key), ZG_KV_TIMEOUT_MS);
      return { value, endpoint };
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(
    `All KV endpoints failed (${endpoints.join(', ')}): ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

class ZgStorageActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor() {
    super('zg-storage', []);
  }

  @CreateAction({
    name: 'zg_storage_save_memory',
    description: 'Save user-scoped memory to 0G KV storage.',
    schema: ZgSaveMemorySchema,
  })
  async saveMemory(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgSaveMemorySchema>
  ): Promise<string> {
    try {
      const address = args.userAddress || (await walletProvider.getAddress());
      const indexer = new Indexer(ZG_INDEXER_RPC);
      const signer = getEthersSigner();
      const flow = getFlowContract(ZG_FLOW_CONTRACT, signer as any);

      const [nodes, nodeErr] = await indexer.selectNodes(1);
      if (nodeErr !== null) return `Error selecting storage nodes: ${nodeErr}`;

      const batcher = new Batcher(1, nodes, flow, ZG_RPC_URL);
      const kvKey = userKey(address, args.key);
      const kvValue = Uint8Array.from(Buffer.from(args.value, 'utf-8'));
      batcher.streamDataBuilder.set(ZG_STREAM_ID, kvKey, kvValue);

      const [tx, batchErr] = await batcher.exec();
      if (batchErr !== null) return `Error writing to KV store: ${batchErr}`;

      return JSON.stringify(
        {
          status: 'memory_saved',
          network: ZG_NETWORK,
          key: args.key,
          namespace: address.toLowerCase(),
          fullKey: `user:${address.toLowerCase()}:${args.key}`,
          transactionHash: tx,
          valueSizeBytes: kvValue.length,
        },
        null,
        2
      );
    } catch (err: any) {
      return `Error saving memory: ${err.message}`;
    }
  }

  @CreateAction({
    name: 'zg_storage_get_memory',
    description: 'Retrieve user-scoped memory from 0G KV storage.',
    schema: ZgGetMemorySchema,
  })
  async getMemory(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgGetMemorySchema>
  ): Promise<string> {
    try {
      const address = args.userAddress || (await walletProvider.getAddress());
      const { value, endpoint } = await readKvValueWithFallback(
        ZG_STREAM_ID,
        userKey(address, args.key)
      );

      if (!value || !value.data) {
        return JSON.stringify({
          status: 'not_found',
          key: args.key,
          namespace: address.toLowerCase(),
          kvEndpoint: endpoint,
        });
      }

      const decoded = Buffer.from(value.data, 'base64').toString('utf-8');
      return JSON.stringify(
        {
          status: 'memory_retrieved',
          network: ZG_NETWORK,
          key: args.key,
          namespace: address.toLowerCase(),
          kvEndpoint: endpoint,
          value: decoded,
        },
        null,
        2
      );
    } catch (err: any) {
      if (err.message?.includes('not found') || err.message?.includes('null')) {
        return JSON.stringify({ status: 'not_found', key: args.key });
      }
      return `Error retrieving memory: ${err.message}`;
    }
  }

  @CreateAction({
    name: 'zg_storage_upload_knowledge',
    description: 'Upload a knowledge document to 0G file storage and index it in KV.',
    schema: ZgUploadKnowledgeSchema,
  })
  async uploadKnowledge(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgUploadKnowledgeSchema>
  ): Promise<string> {
    try {
      const signer = getEthersSigner();
      const indexer = new Indexer(ZG_INDEXER_RPC);

      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const tmpFile = path.join(os.tmpdir(), `0g-kb-${Date.now()}-${args.label}.txt`);
      fs.writeFileSync(tmpFile, args.content, 'utf-8');

      const file = await ZgFile.fromFilePath(tmpFile);
      const [tree, treeErr] = await file.merkleTree();
      if (treeErr !== null) {
        await file.close();
        fs.unlinkSync(tmpFile);
        return `Error computing Merkle tree: ${treeErr}`;
      }

      const rootHash = tree!.rootHash();
      const [tx, uploadErr] = await indexer.upload(file, ZG_RPC_URL, signer as any);
      await file.close();
      fs.unlinkSync(tmpFile);
      if (uploadErr !== null) return `Error uploading to 0G Storage: ${uploadErr}`;

      try {
        const [nodes, nodeErr] = await indexer.selectNodes(1);
        if (nodeErr === null && nodes) {
          const flow = getFlowContract(ZG_FLOW_CONTRACT, signer as any);
          const batcher = new Batcher(1, nodes, flow, ZG_RPC_URL);
          const indexKey = kbIndexKey(args.label);
          const indexValue = Uint8Array.from(
            Buffer.from(
              JSON.stringify({
                rootHash,
                label: args.label,
                uploadedAt: new Date().toISOString(),
                contentLength: args.content.length,
                transactionHash: tx,
              }),
              'utf-8'
            )
          );
          batcher.streamDataBuilder.set(ZG_STREAM_ID, indexKey, indexValue);
          await batcher.exec();
        }
      } catch (kvErr: any) {
        console.warn('KV index write warning:', kvErr.message);
      }

      return JSON.stringify(
        {
          status: 'knowledge_uploaded',
          network: ZG_NETWORK,
          label: args.label,
          rootHash,
          transactionHash: tx,
          contentLength: args.content.length,
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
    description: 'Retrieve a knowledge document by label from 0G storage.',
    schema: ZgGetKnowledgeSchema,
  })
  async getKnowledge(
    _walletProvider: EvmWalletProvider,
    args: z.infer<typeof ZgGetKnowledgeSchema>
  ): Promise<string> {
    try {
      const indexer = new Indexer(ZG_INDEXER_RPC);

      let indexEntry: any;

      try {
        const { value: kvResult } = await readKvValueWithFallback(
          ZG_STREAM_ID,
          kbIndexKey(args.label)
        );
        if (!kvResult || !kvResult.data) {
          return JSON.stringify({ status: 'not_found', label: args.label });
        }
        indexEntry = JSON.parse(Buffer.from(kvResult.data, 'base64').toString('utf-8'));
      } catch {
        return JSON.stringify({ status: 'not_found', label: args.label });
      }

      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const outputPath = path.join(os.tmpdir(), `0g-kb-download-${Date.now()}.txt`);
      const downloadErr = await indexer.download(indexEntry.rootHash, outputPath, true);
      if (downloadErr !== null) return `Error downloading from 0G Storage: ${downloadErr}`;

      const content = fs.readFileSync(outputPath, 'utf-8');
      fs.unlinkSync(outputPath);

      return JSON.stringify(
        {
          status: 'knowledge_retrieved',
          network: ZG_NETWORK,
          label: args.label,
          rootHash: indexEntry.rootHash,
          uploadedAt: indexEntry.uploadedAt,
          content,
          verified: true,
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
