import { PrivyClient, type LinkedAccountWithMetadata } from '@privy-io/server-auth';

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PRIVY_VERIFICATION_KEY = process.env.PRIVY_VERIFICATION_KEY;

if (!PRIVY_APP_ID) {
  throw new Error('Missing NEXT_PUBLIC_PRIVY_APP_ID (or PRIVY_APP_ID) environment variable');
}

if (!PRIVY_APP_SECRET) {
  throw new Error('Missing PRIVY_APP_SECRET environment variable for server-side wallet access');
}

const privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET, {
  walletApi: {
    authorizationPrivateKey: process.env.PRIVY_WALLET_AUTH_PRIVATE_KEY,
  },
});

const normalizeEvmAddress = (addr: string) => (addr.startsWith('0x') ? addr : `0x${addr}`);

function extractCandidateEvmAddresses(
  user: Awaited<ReturnType<typeof privy.getUserById>>
): string[] {
  const addresses = new Set<string>();

  if (user.wallet && ((user.wallet.chainType === 'ethereum') || user.wallet.chainId?.startsWith('eip155'))) {
    addresses.add(normalizeEvmAddress(user.wallet.address));
  }

  user.linkedAccounts
    ?.filter((a: LinkedAccountWithMetadata) => {
      const w = a as LinkedAccountWithMetadata & { address?: string; chainType?: string; chainId?: string };
      return w.type === 'wallet' && ((w.chainType === 'ethereum') || w.chainId?.startsWith('eip155')) && !!w.address;
    })
    .forEach((w) => {
      const addr = (w as { address?: string }).address;
      if (addr) addresses.add(normalizeEvmAddress(addr));
    });

  return [...addresses];
}

async function isWalletSignable(walletId: string): Promise<boolean> {
  try {
    await privy.walletApi.ethereum.signMessage({
      walletId,
      message: 'privy-signability-check',
    });
    return true;
  } catch {
    return false;
  }
}

export async function getPrivyEvmWalletAddress(accessToken: string): Promise<string> {
  if (!accessToken) {
    throw new Error('Missing Privy access token');
  }

  const claims = await privy.verifyAuthToken(accessToken, PRIVY_VERIFICATION_KEY);
  console.log('[Privy] Token verified. userId:', claims.userId);

  const user = await privy.getUserById(claims.userId);
  console.log('[Privy] Fetched user. linkedAccounts:', user.linkedAccounts?.length ?? 0);
  console.log('[Privy] All linked account types:', user.linkedAccounts?.map((a) => a.type));

  const candidateAddresses = extractCandidateEvmAddresses(user);
  const evmAddress = candidateAddresses[0];

  if (evmAddress) {
    const normalized = normalizeEvmAddress(evmAddress);
    console.log('[Privy] Found EVM wallet:', normalized);
    return normalized;
  }

  // Fetch app wallets and only accept a strict address match from this user.
  try {
    const { data: wallets } = await privy.walletApi.getWallets({
      chainType: 'ethereum',
    });

    console.log('[Privy] walletApi wallets for user:', wallets?.map((w) => ({ id: w.id, address: w.address })));

    const wallet = wallets?.find((w) => candidateAddresses.includes(normalizeEvmAddress(w.address)));
    if (wallet?.address) {
      console.log('[Privy] Found via walletApi:', wallet.address);
      return wallet.address;
    }
  } catch (e) {
    console.warn('[Privy] walletApi.getWallets failed:', e);
  }

  throw new Error(
    `No Privy EVM wallet found for user ${claims.userId}. ` +
    `Linked account types: ${user.linkedAccounts?.map((a) => a.type).join(', ')}.`
  );
}

export async function ensurePrivyEmbeddedEvmWallet(accessToken: string): Promise<{ walletId: string; address: string }> {
  if (!accessToken) {
    throw new Error('Missing Privy access token');
  }

  if (!process.env.PRIVY_WALLET_AUTH_PRIVATE_KEY) {
    throw new Error('Missing PRIVY_WALLET_AUTH_PRIVATE_KEY for server-side wallet control');
  }

  const claims = await privy.verifyAuthToken(accessToken, PRIVY_VERIFICATION_KEY);
  console.log('[Privy] ensure embedded wallet. userId:', claims.userId);

  const user = await privy.getUserById(claims.userId);
  console.log('[Privy] ensure embedded wallet. linkedAccounts:', user.linkedAccounts?.length ?? 0);
  console.log('[Privy] ensure embedded wallet. account types:', user.linkedAccounts?.map((a) => a.type));

  const candidateAddresses = extractCandidateEvmAddresses(user);

  // Fetch all app wallets and prefer a signable wallet, but keep a fallback match
  // so quote/read paths can still resolve wallet address even if signing is currently blocked.
  const findControllableWallet = async (): Promise<{
    signable: { walletId: string; address: string } | null;
    fallback: { walletId: string; address: string } | null;
  }> => {
    const { data: wallets } = await privy.walletApi.getWallets({ chainType: 'ethereum' });
    const matches = wallets?.filter((w) => candidateAddresses.includes(normalizeEvmAddress(w.address))) ?? [];
    const fallback = matches[0]
      ? { walletId: matches[0].id, address: normalizeEvmAddress(matches[0].address) }
      : null;
    for (const match of matches) {
      if (await isWalletSignable(match.id)) {
        return {
          signable: { walletId: match.id, address: normalizeEvmAddress(match.address) },
          fallback,
        };
      }
    }
    return { signable: null, fallback };
  };

  const existing = await findControllableWallet();
  if (existing.signable) {
    console.log('[Privy] Found controllable embedded EVM wallet:', existing.signable);
    return existing.signable;
  }
  if (existing.fallback) {
    console.warn(
      '[Privy] Matched EVM wallet is not signable with current auth key. ' +
      `Using fallback walletId ${existing.fallback.walletId} for non-signing operations.`
    );
    return existing.fallback;
  }

  throw new Error(
    `Unable to find a usable embedded EVM wallet for user ${claims.userId}. ` +
    'This usually means PRIVY_WALLET_AUTH_PRIVATE_KEY is missing, invalid, or not authorized for this app wallet.'
  );
}
