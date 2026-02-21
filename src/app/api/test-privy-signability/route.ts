import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getPrivySignabilityReport } from '@/lib/privy';

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

    const report = await getPrivySignabilityReport(accessToken);
    return NextResponse.json({
      ok: report.ok,
      userId: report.userId,
      matchedAddress: report.matchedAddress,
      signableWalletId: report.signableWalletId,
      reason: report.reason ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
