/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ActionProvider,
  CreateAction,
  Network,
  EvmWalletProvider,
} from '@coinbase/agentkit';
import { z } from 'zod';

const UNISWAP_API_BASE = 'https://trade-api.gateway.uniswap.org/v1';
const UNISWAP_API_KEY = process.env.UNISWAP_API_KEY!;
const ETH_SEPOLIA_CHAIN_ID = 11155111;

export const ETH_SEPOLIA_TOKENS = {
  ETH: '0x0000000000000000000000000000000000000000',
  WETH: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
  USDC: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  DAI: '0x68194a729c2450ad26072b3d33adacbcef39d574',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const;

const UniswapSwapSchema = z.object({
  tokenIn: z
    .string()
    .describe(
      'Contract address of the input token. Use 0x0000000000000000000000000000000000000000 for native ETH.'
    ),
  tokenOut: z.string().describe('Contract address of the output token.'),
  amount: z
    .string()
    .describe(
      'Amount of input token in its smallest unit (e.g. wei for ETH, 6-decimal units for USDC).'
    ),
  slippageTolerance: z
    .number()
    .optional()
    .default(0.5)
    .describe('Slippage tolerance as a percentage (e.g. 0.5 = 0.5%).'),
});

const UniswapQuoteSchema = z.object({
  tokenIn: z.string().describe('Contract address of the input token.'),
  tokenOut: z.string().describe('Contract address of the output token.'),
  amount: z.string().describe('Amount of input token in its smallest unit.'),
  slippageTolerance: z
    .number()
    .optional()
    .default(0.5)
    .describe('Slippage tolerance as a percentage.'),
});

interface ApprovalResponse {
  requestId: string;
  approval?: {
    to: string;
    data: string;
    value: string;
    chainId: number;
  };
  cancel?: {
    to: string;
    data: string;
    value: string;
    chainId: number;
  } | null;
}

interface QuoteResponse {
  requestId: string;
  routing:
    | 'CLASSIC'
    | 'DUTCH_V2'
    | 'DUTCH_V3'
    | 'PRIORITY'
    | 'WRAP_UNWRAP'
    | 'BRIDGE';
  quote: Record<string, any>;
  permitData?: {
    domain: Record<string, any>;
    types: Record<string, any>;
    values: Record<string, any>;
  };
}

interface SwapResponse {
  requestId: string;
  swap: {
    to: string;
    from: string;
    data: string;
    value: string;
    chainId: number;
    gasLimit?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
  txFailureReasons?: string[];
}

interface OrderResponse {
  requestId: string;
  orderId?: string;
  orderStatus?: string;
}

class UniswapActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor() {
    super('uniswap-trading', []);
  }

  private async api<T>(endpoint: string, body: Record<string, any>): Promise<T> {
    if (!UNISWAP_API_KEY) {
      throw new Error(
        'UNISWAP_API_KEY env variable is not set. Request an API key from Uniswap: https://hub.uniswap.org'
      );
    }

    const res = await fetch(`${UNISWAP_API_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'x-api-key': UNISWAP_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Uniswap API ${endpoint} returned ${res.status}: ${errBody}`);
    }

    return res.json() as Promise<T>;
  }

  @CreateAction({
    name: 'uniswap_get_quote',
    description:
      'Get a price quote for swapping tokens on Uniswap (Ethereum Sepolia testnet). Returns expected output amount, gas estimate, and routing info.',
    schema: UniswapQuoteSchema,
  })
  async getQuote(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof UniswapQuoteSchema>
  ): Promise<string> {
    try {
      const walletAddress = await walletProvider.getAddress();

      const quoteResponse = await this.api<QuoteResponse>('/quote', {
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        tokenInChainId: ETH_SEPOLIA_CHAIN_ID,
        tokenOutChainId: ETH_SEPOLIA_CHAIN_ID,
        type: 'EXACT_INPUT',
        amount: args.amount,
        swapper: walletAddress,
        slippageTolerance: args.slippageTolerance,
        protocols: ['V2', 'V3', 'V4'],
      });

      const quote = quoteResponse.quote;
      const amountOut =
        quote?.quote ??
        quote?.amountOut ??
        quote?.outputAmount ??
        quote?.output_amount ??
        quote?.output?.amount;
      return JSON.stringify(
        {
          status: 'quote_received',
          routing: quoteResponse.routing,
          quoteId: quoteResponse.requestId,
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amountIn: args.amount,
          amountOut: amountOut ?? null,
          gasEstimate: quote?.gasFee ?? 'unknown',
          rawQuote: quote,
        },
        null,
        2
      );
    } catch (err: any) {
      return `Error getting quote: ${err.message}`;
    }
  }

  @CreateAction({
    name: 'uniswap_swap',
    description:
      'Swap tokens on Uniswap via Trading API on Ethereum Sepolia (11155111). Handles approval, quote, Permit2 signing, and execution.',
    schema: UniswapSwapSchema,
  })
  async swap(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof UniswapSwapSchema>
  ): Promise<string> {
    try {
      const walletAddress = await walletProvider.getAddress();

      const approvalResponse = await this.api<ApprovalResponse>('/check_approval', {
        walletAddress,
        token: args.tokenIn,
        amount: args.amount,
        chainId: ETH_SEPOLIA_CHAIN_ID,
        tokenOut: args.tokenOut,
        tokenOutChainId: ETH_SEPOLIA_CHAIN_ID,
      });

      if (approvalResponse.cancel) {
        const cancelTx = approvalResponse.cancel;
        await walletProvider.sendTransaction({
          to: cancelTx.to as `0x${string}`,
          data: cancelTx.data as `0x${string}`,
          value: BigInt(cancelTx.value || '0'),
        });
        await new Promise((r) => setTimeout(r, 5_000));
      }

      if (approvalResponse.approval) {
        const approvalTx = approvalResponse.approval;
        await walletProvider.sendTransaction({
          to: approvalTx.to as `0x${string}`,
          data: approvalTx.data as `0x${string}`,
          value: BigInt(approvalTx.value || '0'),
        });
        await new Promise((r) => setTimeout(r, 8_000));
      }

      const quoteResponse = await this.api<QuoteResponse>('/quote', {
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        tokenInChainId: ETH_SEPOLIA_CHAIN_ID,
        tokenOutChainId: ETH_SEPOLIA_CHAIN_ID,
        type: 'EXACT_INPUT',
        amount: args.amount,
        swapper: walletAddress,
        slippageTolerance: args.slippageTolerance,
        protocols: ['V2', 'V3', 'V4'],
      });

      if (!quoteResponse.quote) {
        return `Failed to get quote. Response: ${JSON.stringify(quoteResponse)}`;
      }

      let signature: string | undefined;
      if (quoteResponse.permitData) {
        const { domain, types, values } = quoteResponse.permitData;
        const typesWithoutDomain = { ...types };
        if ('EIP712Domain' in typesWithoutDomain) {
          delete typesWithoutDomain.EIP712Domain;
        }

        const primaryType =
          Object.keys(typesWithoutDomain).find(
            (key) =>
              key === 'PermitSingle' ||
              key === 'PermitBatch' ||
              key === 'PermitWitnessTransferFrom'
          ) ?? Object.keys(typesWithoutDomain)[0];

        signature = await walletProvider.signTypedData({
          domain: {
            name: domain.name as string | undefined,
            version: domain.version as string | undefined,
            chainId: domain.chainId ? Number(domain.chainId) : ETH_SEPOLIA_CHAIN_ID,
            verifyingContract: domain.verifyingContract as `0x${string}` | undefined,
            salt: domain.salt as `0x${string}` | undefined,
          },
          types: typesWithoutDomain as Record<string, Array<{ name: string; type: string }>>,
          primaryType,
          message: values as Record<string, unknown>,
        });
      }

      const routing = quoteResponse.routing;
      if (routing === 'CLASSIC' || routing === 'WRAP_UNWRAP' || routing === 'BRIDGE') {
        const swapBody: Record<string, any> = {
          quote: quoteResponse.quote,
          simulateTransaction: true,
        };
        if (signature && quoteResponse.permitData) {
          swapBody.signature = signature;
          swapBody.permitData = quoteResponse.permitData;
        }

        const swapResponse = await this.api<SwapResponse>('/swap', swapBody);
        if (swapResponse.txFailureReasons?.length) {
          return `Swap simulation failed: ${swapResponse.txFailureReasons.join(', ')}`;
        }

        const txHash = await walletProvider.sendTransaction({
          to: swapResponse.swap.to as `0x${string}`,
          from: swapResponse.swap.from as `0x${string}`,
          data: swapResponse.swap.data as `0x${string}`,
          value: BigInt(swapResponse.swap.value || '0'),
          ...(swapResponse.swap.gasLimit && {
            gas: BigInt(swapResponse.swap.gasLimit),
          }),
          ...(swapResponse.swap.maxFeePerGas && {
            maxFeePerGas: BigInt(swapResponse.swap.maxFeePerGas),
          }),
          ...(swapResponse.swap.maxPriorityFeePerGas && {
            maxPriorityFeePerGas: BigInt(swapResponse.swap.maxPriorityFeePerGas),
          }),
        });
        const receipt = await walletProvider.waitForTransactionReceipt(txHash);
        if (!receipt || (typeof receipt.status === 'string' && receipt.status !== 'success')
          || (typeof receipt.status === 'number' && receipt.status !== 1)) {
          return `Swap transaction reverted or not confirmed. txHash: ${txHash}`;
        }

        return JSON.stringify(
          {
            status: 'swap_executed',
            routing: 'CLASSIC',
            transactionHash: txHash,
            receiptStatus: receipt.status,
            explorer: `https://sepolia.etherscan.io/tx/${txHash}`,
            tokenIn: args.tokenIn,
            tokenOut: args.tokenOut,
            amountIn: args.amount,
          },
          null,
          2
        );
      }

      const orderBody: Record<string, any> = { quote: quoteResponse.quote };
      if (signature && quoteResponse.permitData) {
        orderBody.signature = signature;
        orderBody.permitData = quoteResponse.permitData;
      }

      const orderResponse = await this.api<OrderResponse>('/order', orderBody);
      return JSON.stringify(
        {
          status: 'order_submitted',
          routing,
          orderId: orderResponse.orderId ?? orderResponse.requestId,
          orderStatus: orderResponse.orderStatus ?? 'pending',
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amountIn: args.amount,
          note: 'UniswapX order submitted. A market maker will fill this gaslessly.',
        },
        null,
        2
      );
    } catch (err: any) {
      return `Swap failed: ${err.message}`;
    }
  }

  supportsNetwork = (_network: Network): boolean => {
    void _network;
    return true;
  };
}

export const uniswapActionProvider = () => new UniswapActionProvider();
