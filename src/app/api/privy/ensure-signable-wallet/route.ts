import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ensurePrivyEmbeddedEvmWallet, getPrivySignabilityReport } from '@/lib/privy';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const bodyAccessToken = typeof body.accessToken === 'string' ? body.accessToken : null;
    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value ?? null;
    const accessToken = bodyAccessToken ?? cookieToken;

    if (!accessToken) {
      return NextResponse.json({ ok: false, error: 'Missing access token' }, { status: 401 });
    }

    const report = await getPrivySignabilityReport(accessToken, { ensureSignable: true });
    if (!report.ok) {
      // Return 200 so clients can read body without network "failed"; they check ok.
      return NextResponse.json({
        ok: false,
        error: report.reason ?? 'Unable to establish a signable wallet',
        userId: report.userId,
        matchedAddress: report.matchedAddress,
        signableWalletId: report.signableWalletId,
      });
    }

    const selected = await ensurePrivyEmbeddedEvmWallet(accessToken, {
      requireSignable: true,
      ensureSignable: true,
    });

    return NextResponse.json({
      ok: true,
      userId: report.userId,
      createdNewWallet: Boolean(report.createdNewWallet),
      selectedWallet: selected,
      preferredWalletId: report.preferredWalletId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
