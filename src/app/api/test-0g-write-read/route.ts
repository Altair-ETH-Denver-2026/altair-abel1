import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

type ActionLike = {
  name?: string;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
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

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const bodyAccessToken = typeof body.accessToken === 'string' ? body.accessToken : null;

    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value ?? null;
    const accessToken = bodyAccessToken ?? cookieToken;

    if (!accessToken) {
      return NextResponse.json({ error: 'Missing access token' }, { status: 401 });
    }

    const { createAgent } = await import('@/lib/setup');
    const { actions } = await createAgent({
      accessToken,
      evmRpcUrl: process.env.ETH_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
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
    const writeRaw = await saveMemory.invoke({ key, value: JSON.stringify(payload) });
    const readRaw = await getMemory.invoke({ key });

    return NextResponse.json({
      ok: true,
      key,
      write: parseResult(writeRaw),
      read: parseResult(readRaw),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
