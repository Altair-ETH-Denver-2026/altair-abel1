import 'reflect-metadata';
import { AgentKit, PrivyWalletProvider } from '@coinbase/agentkit';
import { uniswapActionProvider } from './providers/uniswapActionProvider';
import { zgInferenceActionProvider } from './providers/zgInferenceActionProvider';
import { zgStorageActionProvider } from './providers/zgStorageActionProvider';
import { ensurePrivyEmbeddedEvmWallet } from './privy';

type CreateWalletProviderParams = {
  accessToken: string;
  evmRpcUrl?: string;
  requireSignable?: boolean;
  requestedWalletAddress?: string;
  requestedWalletId?: string;
};

export async function createWalletProvider({
  accessToken,
  evmRpcUrl,
  requireSignable,
  requestedWalletAddress,
  requestedWalletId,
}: CreateWalletProviderParams) {
  const selectedWallet = await ensurePrivyEmbeddedEvmWallet(accessToken, {
    requireSignable,
    requestedWalletAddress,
    requestedWalletId,
  });

  const walletProvider = await PrivyWalletProvider.configureWithWallet({
    appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? process.env.PRIVY_APP_ID ?? '',
    appSecret: process.env.PRIVY_APP_SECRET!,
    authorizationPrivateKey: process.env.PRIVY_WALLET_AUTH_PRIVATE_KEY,
    authorizationKeyId: process.env.PRIVY_WALLET_AUTH_ID,
    walletType: 'embedded',
    chainType: 'ethereum',
    chainId: '11155111',
    rpcUrl:
      evmRpcUrl
      ?? process.env.ETH_SEPOLIA_RPC_URL
      ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    walletId: selectedWallet.walletId,
  });

  return { walletProvider, selectedWallet };
}

type CreateAgentParams = {
  accessToken: string;
  evmRpcUrl?: string;
  requireSignable?: boolean;
  requestedWalletAddress?: string;
  requestedWalletId?: string;
};

type AgentKitInit = NonNullable<Parameters<typeof AgentKit.from>[0]>;

export async function createAgent({
  accessToken,
  evmRpcUrl,
  requireSignable,
  requestedWalletAddress,
  requestedWalletId,
}: CreateAgentParams) {
  const { walletProvider, selectedWallet } = await createWalletProvider({
    accessToken,
    evmRpcUrl,
    requireSignable,
    requestedWalletAddress,
    requestedWalletId,
  });

  const agentKit = await AgentKit.from(
    {
      walletProvider,
      actionProviders: [
        uniswapActionProvider(),
        zgInferenceActionProvider(),
        zgStorageActionProvider(),
      ],
    } as unknown as AgentKitInit
  );

  const actions = agentKit.getActions();
  return { agentKit, walletProvider, actions, selectedWallet };
}
