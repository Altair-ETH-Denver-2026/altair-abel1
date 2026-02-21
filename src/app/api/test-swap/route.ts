import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const ETH_TO_SWAP = 0.000001;

export async function POST(req: Request) {
  try {
    const { accessToken: bodyToken } = await req
      .json()
      .catch(() => ({ accessToken: null }));

    // Prefer signed Privy token (ID/Auth) from HTTP-only cookie, else fall back to body token (same as balances flow)
    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value;
    console.log('[Test Swap] cookie privy-token present:', !!cookieToken, 'len:', cookieToken?.length ?? 0);
    console.log('[Test Swap] body accessToken present:', !!bodyToken, 'len:', bodyToken?.length ?? 0);

    const tokenToVerify = cookieToken ?? bodyToken;

    if (!tokenToVerify) {
      return NextResponse.json({ error: 'Missing Privy token' }, { status: 401 });
    }

    // Resolve or create a Privy-controlled embedded EVM wallet (server-signable)
    const [{ initAgentKit, executeSwap }, { ensurePrivyEmbeddedEvmWallet }] = await Promise.all([
      import('@/lib/agentkit'),
      import('@/lib/privy'),
    ]);

    await ensurePrivyEmbeddedEvmWallet(tokenToVerify);

    const agentKit = await initAgentKit({
      evmRpcUrl:
        process.env.ETH_SEPOLIA_RPC_URL
        ?? 'https://ethereum-sepolia-rpc.publicnode.com',
      accessToken: tokenToVerify ?? '',
    });

    const result = await executeSwap(agentKit, {
      sellToken: 'ETH',
      buyToken: 'USDC',
      amount: ETH_TO_SWAP,
    });

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error('Test swap error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
