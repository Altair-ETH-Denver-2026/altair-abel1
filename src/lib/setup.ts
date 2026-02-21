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
};

export async function createWalletProvider({
  accessToken,
  evmRpcUrl,
  requireSignable,
}: CreateWalletProviderParams) {
  const { walletId } = await ensurePrivyEmbeddedEvmWallet(accessToken, { requireSignable });

  return PrivyWalletProvider.configureWithWallet({
    appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? process.env.PRIVY_APP_ID ?? '',
    appSecret: process.env.PRIVY_APP_SECRET!,
    chainId: '11155111',
    rpcUrl:
      evmRpcUrl
      ?? process.env.ETH_SEPOLIA_RPC_URL
      ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    walletId,
  });
}

type CreateAgentParams = {
  accessToken: string;
  evmRpcUrl?: string;
  requireSignable?: boolean;
};

type AgentKitInit = NonNullable<Parameters<typeof AgentKit.from>[0]>;

export async function createAgent({ accessToken, evmRpcUrl, requireSignable }: CreateAgentParams) {
  const walletProvider = await createWalletProvider({ accessToken, evmRpcUrl, requireSignable });

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
  return { agentKit, walletProvider, actions };
}
