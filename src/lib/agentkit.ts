import {
  AgentKit,
  PrivyWalletProvider,
  walletActionProvider,
  erc20ActionProvider,
  zeroXActionProvider,
} from '@coinbase/agentkit';
import { ensurePrivyEmbeddedEvmWallet } from './privy';

type InitAgentKitParams = {
  evmRpcUrl: string;
  accessToken: string; // Privy access token from the client
};

/**
 * Initialize AgentKit with the user's Privy smart wallet on Ethereum Sepolia.
 */
export async function initAgentKit({ evmRpcUrl, accessToken }: InitAgentKitParams) {
  if (!process.env.CDP_API_KEY_NAME || !process.env.CDP_API_KEY_SECRET) {
    throw new Error('Missing CDP_API_KEY_NAME or CDP_API_KEY_SECRET environment variables');
  }

  // Resolve or create a Privy-controlled embedded EVM wallet (required for server signing)
  const { walletId } = await ensurePrivyEmbeddedEvmWallet(accessToken);

  // Configure a Privy-backed wallet provider (EVM server wallet on Ethereum Sepolia)
  const walletProvider = await PrivyWalletProvider.configureWithWallet({
    appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? process.env.PRIVY_APP_ID ?? '',
    appSecret: process.env.PRIVY_APP_SECRET ?? '',
    authorizationPrivateKey: process.env.PRIVY_WALLET_AUTH_PRIVATE_KEY,
    authorizationKeyId: process.env.PRIVY_WALLET_AUTH_ID,
    chainId: '11155111',
    rpcUrl: evmRpcUrl,
    walletId,
  });

  const agentKit = await AgentKit.from({
    walletProvider,
    actionProviders: [
      walletActionProvider(),
      erc20ActionProvider(),
      zeroXActionProvider({ apiKey: process.env.UNISWAP_API_KEY }),
    ],
  });

  return agentKit;
}

export type SwapInput = {
  sellToken: string;
  buyToken: string;
  amount: number;
};

/**
 * Execute a swap through the AgentKit actions (CDP-backed swap on Ethereum Sepolia).
 */
export async function executeSwap(agentKit: AgentKit, { sellToken, buyToken, amount }: SwapInput) {
  // Try to find the CDP swap action explicitly
  const actions = agentKit.getActions();
  const swap = actions.find((a) => a.name?.toLowerCase().includes('swap'));
  if (!swap || !swap.invoke) {
    throw new Error('Swap action not available');
  }

  const result = await swap.invoke({
    fromToken: sellToken,
    toToken: buyToken,
    amount,
    chainId: 'ethereum-sepolia',
  } as {
    fromToken: string;
    toToken: string;
    amount: number;
    chainId: string;
  });

  return result;
}

