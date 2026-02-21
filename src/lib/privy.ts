import { PrivyClient, type AuthorizationContext } from '@privy-io/node';

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

const privy = new PrivyClient({
  appId: PRIVY_APP_ID,
  appSecret: PRIVY_APP_SECRET,
  jwtVerificationKey: PRIVY_VERIFICATION_KEY,
});

const normalizeEvmAddress = (addr: string) => (addr.startsWith('0x') ? addr : `0x${addr}`);
const preferredWalletByUserId = new Map<string, { walletId: string; address: string }>();

type AccessClaims = { userId: string };
type PrivyWalletListItem = { id: string; address: string };

function getString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function getNestedString(obj: unknown, keyA: string, keyB: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const nested = (obj as Record<string, unknown>)[keyA];
  return getString(nested, keyB);
}

async function verifyAccessTokenClaims(accessToken: string): Promise<AccessClaims> {
  const clientAny = privy as unknown as {
    verifyAuthToken?: (token: string, verificationKey?: string) => Promise<unknown>;
    utils?: () => { auth: () => { verifyAccessToken: (params: { access_token: string }) => Promise<unknown> } };
  };

  if (typeof clientAny.verifyAuthToken === 'function') {
    const claims = await clientAny.verifyAuthToken(accessToken, PRIVY_VERIFICATION_KEY);
    const userId = getString(claims, 'userId') ?? getString(claims, 'user_id');
    if (!userId) throw new Error('Unable to resolve userId from Privy auth token');
    return { userId };
  }

  if (typeof clientAny.utils === 'function') {
    const claims = await clientAny.utils().auth().verifyAccessToken({ access_token: accessToken });
    const userId = getString(claims, 'userId') ?? getString(claims, 'user_id');
    if (!userId) throw new Error('Unable to resolve userId from Privy access token');
    return { userId };
  }

  throw new Error('Privy client does not expose access-token verification methods');
}

async function listUserEthereumWallets(userId: string): Promise<PrivyWalletListItem[]> {
  const clientAny = privy as unknown as {
    wallets?: () => {
      list: (params: { user_id?: string; chain_type?: 'ethereum' | 'solana' }) => AsyncIterable<unknown>;
    };
    walletApi?: {
      getWallets: (params: { chainType: 'ethereum'; cursor?: string }) => Promise<{ data?: unknown[]; nextCursor?: string }>;
    };
  };

  if (typeof clientAny.wallets === 'function') {
    const wallets: PrivyWalletListItem[] = [];
    for await (const wallet of clientAny.wallets().list({ user_id: userId, chain_type: 'ethereum' })) {
      const id = getString(wallet, 'id');
      const address = getString(wallet, 'address');
      if (id && address) wallets.push({ id, address: normalizeEvmAddress(address) });
    }
    return wallets;
  }

  if (clientAny.walletApi?.getWallets) {
    const wallets: PrivyWalletListItem[] = [];
    let nextCursor: string | undefined;
    do {
      const page = await clientAny.walletApi.getWallets({ chainType: 'ethereum', cursor: nextCursor });
      const pageWallets = (page.data ?? [])
        .map((w) => ({
          id: getString(w, 'id') ?? '',
          address: normalizeEvmAddress(getString(w, 'address') ?? ''),
          ownerId: getString(w, 'owner_id') ?? getString(w, 'ownerId') ?? getNestedString(w, 'owner', 'user_id'),
        }))
        .filter((w) => Boolean(w.id) && Boolean(w.address) && w.ownerId === userId)
        .map((w) => ({ id: w.id, address: w.address }));
      wallets.push(...pageWallets);
      nextCursor = page.nextCursor;
    } while (nextCursor);
    return wallets;
  }

  throw new Error('Privy client does not expose wallet listing methods');
}

async function signMessageWithAuthContext(walletId: string): Promise<void> {
  const authContext: AuthorizationContext = {
    authorization_private_keys: PRIVY_WALLET_AUTH_PRIVATE_KEY ? [PRIVY_WALLET_AUTH_PRIVATE_KEY] : [],
  };
  const clientAny = privy as unknown as {
    wallets?: () => {
      ethereum: () => {
        signMessage: (
          walletId: string,
          params: { message: string; authorization_context?: AuthorizationContext }
        ) => Promise<unknown>;
      };
    };
    walletApi?: {
      ethereum?: {
        signMessage: (params: { walletId: string; message: string }) => Promise<unknown>;
      };
    };
  };

  if (typeof clientAny.wallets === 'function') {
    await clientAny.wallets().ethereum().signMessage(walletId, {
      message: 'privy-signability-check',
      authorization_context: authContext,
    });
    return;
  }

  if (clientAny.walletApi?.ethereum?.signMessage) {
    await clientAny.walletApi.ethereum.signMessage({
      walletId,
      message: 'privy-signability-check',
    });
    return;
  }

  throw new Error('Privy client does not expose ethereum signMessage methods');
}

async function isWalletSignable(walletId: string): Promise<boolean> {
  try {
    await signMessageWithAuthContext(walletId);
    return true;
  } catch {
    return false;
  }
}

async function createUserEthereumWallet(userId: string): Promise<void> {
  const clientAny = privy as unknown as {
    wallets?: () => {
      create: (params: { chain_type: 'ethereum'; owner: { user_id: string } }) => Promise<unknown>;
    };
  };
  if (!clientAny.wallets) {
    throw new Error('Privy client does not expose wallets.create');
  }
  await clientAny.wallets().create({
    chain_type: 'ethereum',
    owner: { user_id: userId },
  });
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
  const { userId } = await verifyAccessTokenClaims(accessToken);
  const matched = await listUserEthereumWallets(userId);

  const matches: MatchedWallet[] = [];
  for (const wallet of matched) {
    matches.push({
      walletId: wallet.id,
      address: normalizeEvmAddress(wallet.address),
      signable: await isWalletSignable(wallet.id),
    });
  }

  return { userId, matches };
}

export type PrivySignabilityReport = {
  ok: boolean;
  userId: string;
  matchedAddress: string | null;
  signableWalletId: string | null;
  preferredWalletId: string | null;
  createdNewWallet?: boolean;
  reason?: string;
};

type GetPrivySignabilityReportOptions = {
  ensureSignable?: boolean;
};

export async function getPrivySignabilityReport(
  accessToken: string,
  options?: GetPrivySignabilityReportOptions
): Promise<PrivySignabilityReport> {
  if (!accessToken) {
    throw new Error('Missing Privy access token');
  }

  let { userId, matches } = await getUserMatchedWallets(accessToken);
  let createdNewWallet = false;
  if (options?.ensureSignable && !matches.some((m) => m.signable)) {
    await createUserEthereumWallet(userId);
    const refreshed = await getUserMatchedWallets(accessToken);
    userId = refreshed.userId;
    matches = refreshed.matches;
    createdNewWallet = true;
  }

  const preferred = preferredWalletByUserId.get(userId);
  const preferredSignable = preferred
    ? matches.find((m) => m.walletId === preferred.walletId && m.signable)
    : undefined;
  if (preferredSignable) {
    return {
      ok: true,
      userId,
      matchedAddress: preferredSignable.address,
      signableWalletId: preferredSignable.walletId,
      preferredWalletId: preferredSignable.walletId,
      createdNewWallet,
    };
  }

  for (const match of matches) {
    if (match.signable) {
      preferredWalletByUserId.set(userId, { walletId: match.walletId, address: match.address });
      return {
        ok: true,
        userId,
        matchedAddress: match.address,
        signableWalletId: match.walletId,
        preferredWalletId: match.walletId,
        createdNewWallet,
      };
    }
  }

  return {
    ok: false,
    userId,
    matchedAddress: matches[0]?.address ?? null,
    signableWalletId: null,
    preferredWalletId: null,
    createdNewWallet,
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
  const { userId, matches } = await getUserMatchedWallets(accessToken);
  if (matches[0]) return matches[0].address;

  throw new Error(
    `No Privy EVM wallet found for user ${userId}.`
  );
}

type EnsurePrivyEmbeddedEvmWalletOptions = {
  requireSignable?: boolean;
  requestedWalletAddress?: string;
  requestedWalletId?: string;
  ensureSignable?: boolean;
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

  const signability = await getPrivySignabilityReport(accessToken, { ensureSignable: options?.ensureSignable });
  const { userId } = signability;
  const { matches } = await getUserMatchedWallets(accessToken);
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

  const preferred = preferredWalletByUserId.get(userId);
  const signable = (preferred
    ? matches.find((m) => m.signable && m.walletId === preferred.walletId)
    : undefined) ?? matches.find((m) => m.signable);
  if (signable) {
    preferredWalletByUserId.set(userId, { walletId: signable.walletId, address: signable.address });
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
