import { NextResponse } from 'next/server';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function GET() {
  const prev = {
    mode: process.env.ZG_STORAGE_MODE,
    fallback: process.env.ZG_ENABLE_LOCAL_FALLBACK,
    fallbackPath: process.env.ZG_LOCAL_FALLBACK_PATH,
    indexPath: process.env.ZG_LOCAL_INDEX_PATH,
  };

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'altair-0g-namespace-test-'));
  const fallbackPath = path.join(tmpRoot, 'fallback.json');
  const indexPath = path.join(tmpRoot, 'index.json');

  try {
    // Force deterministic local-only behavior for namespace validation.
    process.env.ZG_STORAGE_MODE = 'local_only';
    process.env.ZG_ENABLE_LOCAL_FALLBACK = 'true';
    process.env.ZG_LOCAL_FALLBACK_PATH = fallbackPath;
    process.env.ZG_LOCAL_INDEX_PATH = indexPath;

    const walletAddress = '0x0F0F43cf7458eb800bd65B0Eb423E71d53322DE2';
    const userA = 'did:privy:user-A';
    const userB = 'did:privy:user-B';
    const key = 'chat_summary_latest';
    const valueA = JSON.stringify({ userMessage: 'hello from A' });
    const valueB = JSON.stringify({ userMessage: 'hello from B' });

    const { zgStorageActionProvider } = await import('@/lib/providers/zgStorageActionProvider');
    const provider = zgStorageActionProvider() as unknown as {
      saveMemory: (walletProvider: { getAddress: () => Promise<string> }, args: Record<string, unknown>) => Promise<string>;
      getMemory: (walletProvider: { getAddress: () => Promise<string> }, args: Record<string, unknown>) => Promise<string>;
    };
    const walletProvider = { getAddress: async () => walletAddress } as unknown as {
      getAddress: () => Promise<string>;
    };

    const saveA = JSON.parse(
      await provider.saveMemory(walletProvider, { key, value: valueA, userId: userA })
    ) as Record<string, unknown>;
    const saveB = JSON.parse(
      await provider.saveMemory(walletProvider, { key, value: valueB, userId: userB })
    ) as Record<string, unknown>;

    const expectedNamespaceA = `privy:${userA}:wallet:${walletAddress.toLowerCase()}`;
    const expectedNamespaceB = `privy:${userB}:wallet:${walletAddress.toLowerCase()}`;

    assert.equal(saveA.status, 'memory_saved_fallback');
    assert.equal(saveA.namespace, expectedNamespaceA);
    assert.equal(saveA.userId, userA);
    assert.equal(saveA.walletAddress, walletAddress.toLowerCase());

    assert.equal(saveB.status, 'memory_saved_fallback');
    assert.equal(saveB.namespace, expectedNamespaceB);
    assert.equal(saveB.userId, userB);
    assert.equal(saveB.walletAddress, walletAddress.toLowerCase());

    const getA = JSON.parse(await provider.getMemory(walletProvider, { key, userId: userA })) as Record<
      string,
      unknown
    >;
    const getB = JSON.parse(await provider.getMemory(walletProvider, { key, userId: userB })) as Record<
      string,
      unknown
    >;

    assert.equal(getA.status, 'memory_retrieved');
    assert.equal(getA.namespace, expectedNamespaceA);
    assert.equal(getA.value, valueA);

    assert.equal(getB.status, 'memory_retrieved');
    assert.equal(getB.namespace, expectedNamespaceB);
    assert.equal(getB.value, valueB);

    const fallbackData = JSON.parse(await fs.readFile(fallbackPath, 'utf-8')) as Record<string, string>;
    const keys = Object.keys(fallbackData);
    assert(keys.some((k) => k.includes(`privy:${userA}:wallet:${walletAddress.toLowerCase()}:${key}`)));
    assert(keys.some((k) => k.includes(`privy:${userB}:wallet:${walletAddress.toLowerCase()}:${key}`)));

    return NextResponse.json({
      ok: true,
      message: 'User-scoped memory namespacing works and isolates by userId + wallet.',
      namespaces: [expectedNamespaceA, expectedNamespaceB],
      fallbackPath,
      savedStatuses: [saveA.status, saveB.status],
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  } finally {
    process.env.ZG_STORAGE_MODE = prev.mode;
    process.env.ZG_ENABLE_LOCAL_FALLBACK = prev.fallback;
    process.env.ZG_LOCAL_FALLBACK_PATH = prev.fallbackPath;
    process.env.ZG_LOCAL_INDEX_PATH = prev.indexPath;
  }
}

