import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { Indexer, KvClient } from '@0glabs/0g-ts-sdk';

function getKvEndpoints(): string[] {
  const primary = process.env.ZG_KV_RPC ?? 'http://3.101.147.150:6789';
  const fallbacks = (process.env.ZG_KV_RPC_FALLBACKS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [primary, ...fallbacks];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

export async function GET() {
  const rpcUrl = process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai/';
  const indexerRpc = process.env.ZG_INDEXER_RPC ?? 'https://indexer-storage-testnet-turbo.0g.ai/';
  const streamId = process.env.ZG_STREAM_ID ?? null;
  const address = process.env.ZG_ADDRESS ?? null;
  const kvTimeoutMs = Number(process.env.ZG_KV_TIMEOUT_MS ?? 5000);
  const kvEndpoints = getKvEndpoints();

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const indexer = new Indexer(indexerRpc);

  const rpcCheck = await (async () => {
    try {
      const network = await provider.getNetwork();
      const balance = address ? ethers.formatEther(await provider.getBalance(address)) : null;
      return { ok: true, chainId: network.chainId.toString(), balance };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  })();

  const indexerCheck = await (async () => {
    try {
      const [nodes, nodeErr] = await indexer.selectNodes(1);
      if (nodeErr) return { ok: false, error: String(nodeErr) };
      return {
        ok: true,
        count: nodes.length,
        nodes: nodes.map((n) => n.url),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  })();

  const kvChecks = await Promise.all(
    kvEndpoints.map(async (endpoint) => {
      try {
        const client = new KvClient(endpoint);
        const streamIds = await withTimeout(client.getHoldingStreamIds(), kvTimeoutMs);
        return { endpoint, ok: true, streamIdsCount: streamIds?.length ?? 0 };
      } catch (err) {
        return { endpoint, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  return NextResponse.json({
    ok: rpcCheck.ok && indexerCheck.ok && kvChecks.some((k) => k.ok),
    config: {
      rpcUrl,
      indexerRpc,
      streamId,
      kvEndpoints,
      kvTimeoutMs,
    },
    rpc: rpcCheck,
    indexer: indexerCheck,
    kv: kvChecks,
    notes: [
      'If rpc/indexer pass but writes still revert, issue is likely contract-side or wallet permissions/state.',
      'If all kv endpoints fail, reads cannot succeed until at least one KV node endpoint is reachable.',
    ],
  });
}
