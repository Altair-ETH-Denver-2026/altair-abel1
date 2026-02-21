import { PrivyClient, type LinkedAccountWithMetadata } from '@privy-io/server-auth';

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PRIVY_VERIFICATION_KEY = process.env.PRIVY_VERIFICATION_KEY;
const PRIVY_WALLET_AUTH_PRIVATE_KEY = process.env.PRIVY_WALLET_AUTH_PRIVATE_KEY;

const hasWrappingQuotes = (value: string) =>
  (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));

if (!PRIVY_APP_ID) {
  throw new Error('Missing NEXT_PUBLIC_PRIVY_APP_ID (or PRIVY_APP_ID) environment variable');
}

if (!PRIVY_APP_SECRET) {
  throw new Error('Missing PRIVY_APP_SECRET environment variable for server-side wallet access');
}

if (hasWrappingQuotes(PRIVY_APP_ID)) {
  throw new Error('NEXT_PUBLIC_PRIVY_APP_ID (or PRIVY_APP_ID) must not be wrapped in quotes');
}

if (hasWrappingQuotes(PRIVY_APP_SECRET)) {
  throw new Error('PRIVY_APP_SECRET must not be wrapped in quotes');
}

if (PRIVY_WALLET_AUTH_PRIVATE_KEY && !PRIVY_WALLET_AUTH_PRIVATE_KEY.startsWith('wallet-auth:')) {
  throw new Error('PRIVY_WALLET_AUTH_PRIVATE_KEY must start with "wallet-auth:"');
}

const privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET, {
  walletApi: {
    authorizationPrivateKey: PRIVY_WALLET_AUTH_PRIVATE_KEY,
  },
});

const normalizeEvmAddress = (addr: string) => (addr.startsWith('0x') ? addr : `0x${addr}`);

type PrivyWalletListItem = {
  id: string;
  address: string;
};

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

async function getAllEthereumWallets(): Promise<PrivyWalletListItem[]> {
  const wallets: PrivyWalletListItem[] = [];
  let nextCursor: string | undefined;

  do {
    const page = await privy.walletApi.getWallets({
      chainType: 'ethereum',
      cursor: nextCursor,
    });
    wallets.push(...((page.data as PrivyWalletListItem[] | undefined) ?? []));
    nextCursor = page.nextCursor;
  } while (nextCursor);

  return wallets;
}

type MatchedWallet = {
  walletId: string;
  address: string;
  signable: boolean;
};

async function getUserMatchedWallets(accessToken: string): Promise<{
  userId: string;
  matches: MatchedWallet[];
}> {
  if (!PRIVY_VERIFICATION_KEY) {
    throw new Error('Missing PRIVY_VERIFICATION_KEY');
  }

  const claims = await privy.verifyAuthToken(accessToken, PRIVY_VERIFICATION_KEY);
  const user = await privy.getUserById(claims.userId);
  const candidateAddresses = extractCandidateEvmAddresses(user);
  const allWallets = await getAllEthereumWallets();
  const matched = allWallets.filter((w) => candidateAddresses.includes(normalizeEvmAddress(w.address)));

  const matches: MatchedWallet[] = [];
  for (const wallet of matched) {
    matches.push({
      walletId: wallet.id,
      address: normalizeEvmAddress(wallet.address),
      signable: await isWalletSignable(wallet.id),
    });
  }

  return { userId: claims.userId, matches };
}

export type PrivySignabilityReport = {
  ok: boolean;
  userId: string;
  matchedAddress: string | null;
  signableWalletId: string | null;
  reason?: string;
};

export async function getPrivySignabilityReport(accessToken: string): Promise<PrivySignabilityReport> {
  if (!accessToken) {
    throw new Error('Missing Privy access token');
  }

  const { userId, matches } = await getUserMatchedWallets(accessToken);

  for (const match of matches) {
    if (match.signable) {
      return {
        ok: true,
        userId,
        matchedAddress: match.address,
        signableWalletId: match.walletId,
      };
    }
  }

  return {
    ok: false,
    userId,
    matchedAddress: matches[0]?.address ?? null,
    signableWalletId: null,
    reason:
      matches.length > 0
        ? 'Matched wallet exists but is not signable with current wallet auth key for this app.'
        : 'No wallet matched this user within current app wallet scope.',
  };
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
    const wallets = await getAllEthereumWallets();

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

type EnsurePrivyEmbeddedEvmWalletOptions = {
  requireSignable?: boolean;
  requestedWalletAddress?: string;
  requestedWalletId?: string;
};

export async function ensurePrivyEmbeddedEvmWallet(
  accessToken: string,
  options?: EnsurePrivyEmbeddedEvmWalletOptions
): Promise<{ walletId: string; address: string }> {
  if (!accessToken) {
    throw new Error('Missing Privy access token');
  }

  if (!process.env.PRIVY_WALLET_AUTH_PRIVATE_KEY) {
    throw new Error('Missing PRIVY_WALLET_AUTH_PRIVATE_KEY for server-side wallet control');
  }

  const { userId, matches } = await getUserMatchedWallets(accessToken);
  console.log('[Privy] ensure embedded wallet. userId:', userId, 'matched wallets:', matches.length);
  const requireSignable = options?.requireSignable ?? true;
  const requestedWalletAddress = options?.requestedWalletAddress
    ? normalizeEvmAddress(options.requestedWalletAddress)
    : undefined;
  const requestedWalletId = options?.requestedWalletId;
  const hasRequested = Boolean(requestedWalletAddress || requestedWalletId);

  let requestedMatch: MatchedWallet | undefined;
  if (hasRequested) {
    requestedMatch = matches.find(
      (m) =>
        (requestedWalletId && m.walletId === requestedWalletId)
        || (requestedWalletAddress && m.address.toLowerCase() === requestedWalletAddress.toLowerCase())
    );
    if (!requestedMatch) {
      throw new Error(
        'Requested wallet was not found for this user within current app wallet scope. ' +
        'Use a wallet linked to this Privy user in this app.'
      );
    }
  }

  if (requestedMatch) {
    if (!requireSignable || requestedMatch.signable) {
      return { walletId: requestedMatch.walletId, address: requestedMatch.address };
    }
    const backup = matches.find((m) => m.signable && m.walletId !== requestedMatch.walletId);
    if (backup) {
      console.warn(
        `[Privy] Requested wallet ${requestedMatch.address} is not signable; using backup signable wallet ${backup.address}.`
      );
      return { walletId: backup.walletId, address: backup.address };
    }
    throw new Error(
      `Requested wallet ${requestedMatch.address} is not signable with current Privy auth key, and no backup signable wallet was found. ` +
      'Rotate PRIVY_WALLET_AUTH_PRIVATE_KEY (wallet-auth:...) or request a different wallet.'
    );
  }

  const signable = matches.find((m) => m.signable);
  if (signable) {
    return { walletId: signable.walletId, address: signable.address };
  }
  const fallback = matches[0];
  if (fallback && !requireSignable) {
    console.warn(
      '[Privy] Matched EVM wallet is not signable with current auth key. ' +
      `Using fallback walletId ${fallback.walletId} for non-signing operations.`
    );
    return { walletId: fallback.walletId, address: fallback.address };
  }

  throw new Error(
    `Unable to find a usable embedded EVM wallet for user ${userId}. ` +
    'This usually means PRIVY_WALLET_AUTH_PRIVATE_KEY is missing, invalid, or not authorized for this app wallet.'
  );
}
