import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ethers } from 'ethers';

type ActionLike = {
  name?: string;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
};

function sessionKeyFromAccessToken(accessToken?: string | null): string {
  if (!accessToken) return 'anonymous';
  const parts = accessToken.split('.');
  if (parts.length < 2) return accessToken;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, string>;
    return payload.sub ?? payload.sid ?? accessToken;
  } catch {
    return accessToken;
  }
}

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

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const bodyAccessToken = typeof body.accessToken === 'string' ? body.accessToken : null;

    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value ?? null;
    const accessToken = bodyAccessToken ?? cookieToken;
    const userId = sessionKeyFromAccessToken(accessToken);

    if (!accessToken) {
      return NextResponse.json({ error: 'Missing access token' }, { status: 401 });
    }

    const { createAgent } = await import('@/lib/setup');
    const { actions } = await createAgent({
      accessToken,
      evmRpcUrl: process.env.ETH_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
      requireSignable: false,
    });
    const typedActions = actions as unknown as ActionLike[];

    const saveMemory =
      typedActions.find((a) => a.name === 'zg_storage_save_memory')
      ?? typedActions.find((a) => a.name?.toLowerCase().includes('save_memory'));
    const getMemory =
      typedActions.find((a) => a.name === 'zg_storage_get_memory')
      ?? typedActions.find((a) => a.name?.toLowerCase().includes('get_memory'));

    if (!saveMemory || !getMemory) {
      return NextResponse.json(
        {
          error: 'Required 0G memory actions not registered',
          availableActions: typedActions.map((a) => a.name ?? '(unnamed)'),
        },
        { status: 500 }
      );
    }

    const key = `ping_${Date.now()}`;
    const payload = { ping: true, at: new Date().toISOString() };
    const writeRaw = await saveMemory.invoke({ key, userId, value: JSON.stringify(payload) });
    const readRaw = await getMemory.invoke({ key, userId });
    const parsedWrite = parseResult(writeRaw);
    const parsedRead = parseResult(readRaw);

    const writeRawText =
      parsedWrite && typeof parsedWrite.raw === 'string' ? parsedWrite.raw : '';
    const diagnostics =
      writeRawText.includes('execution reverted')
        ? await (async () => {
          try {
            const provider = new ethers.JsonRpcProvider(
              process.env.ZG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai/'
            );
            const chainId = (await provider.getNetwork()).chainId.toString();
            const address = process.env.ZG_ADDRESS ?? null;
            const balance = address ? ethers.formatEther(await provider.getBalance(address)) : null;
            return {
              chainId,
              zgAddress: address,
              zgBalance: balance,
              note: 'Write reverted on-chain at flow.submit; this is not a local route crash.',
            };
          } catch (diagErr) {
            return {
              note: diagErr instanceof Error ? diagErr.message : 'Failed to collect diagnostics',
            };
          }
        })()
        : null;

    return NextResponse.json({
      ok: true,
      key,
      userId,
      write: parsedWrite,
      read: parsedRead,
      diagnostics,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
