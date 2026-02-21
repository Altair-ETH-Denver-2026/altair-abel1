import { NextResponse } from 'next/server';
import { createPublicClient, http, formatEther, formatUnits } from 'viem';
import { sepolia } from 'viem/chains';
import { ensurePrivyEmbeddedEvmWallet, getPrivyEvmWalletAddress } from '@/lib/privy';
import { cookies } from 'next/headers';

const USDC_ABI = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export async function POST(req: Request) {
  try {
    const { walletAddress: overrideAddress, accessToken } = await req
      .json()
      .catch(() => ({ walletAddress: undefined, accessToken: undefined }));

    // Prefer explicit access token from the request body (current user session),
    // then fallback to cookie token for compatibility.
    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value;
    const tokenToVerify = accessToken ?? cookieToken;

    let resolvedAddress: string | null = null;
    if (tokenToVerify) {
      try {
        resolvedAddress = (await ensurePrivyEmbeddedEvmWallet(tokenToVerify)).address;
      } catch (firstErr) {
        console.warn('Embedded wallet resolution failed, trying address-only fallback:', firstErr);
        try {
          resolvedAddress = await getPrivyEvmWalletAddress(tokenToVerify);
        } catch (secondErr) {
          console.warn('Address-only fallback failed:', secondErr);
          // If caller passed an invalid/stale token, try cookie token as a final fallback.
          if (accessToken && cookieToken && accessToken !== cookieToken) {
            try {
              resolvedAddress = (await ensurePrivyEmbeddedEvmWallet(cookieToken)).address;
            } catch (thirdErr) {
              console.warn('Cookie embedded wallet fallback failed:', thirdErr);
              try {
                resolvedAddress = await getPrivyEvmWalletAddress(cookieToken);
              } catch (fourthErr) {
                console.warn('Cookie address-only fallback failed:', fourthErr);
              }
            }
          }
        }
      }
    }
    const addressToQuery = (overrideAddress ?? resolvedAddress) as `0x${string}` | null;

    if (!addressToQuery) {
      return NextResponse.json({
        address: null,
        eth: '0',
        usdc: '0',
        warning: 'Unable to resolve wallet address for this session',
      });
    }

    const client = createPublicClient({
      chain: sepolia,
      transport: http(
        process.env.ETH_SEPOLIA_RPC_URL
        ?? 'https://ethereum-sepolia-rpc.publicnode.com'
      ),
    });

    const ethBalanceRaw = await client.getBalance({ address: addressToQuery });
    const eth = formatEther(ethBalanceRaw);
    let usdc = '0';

    const usdcAddress = process.env.USDC_CONTRACT_SEPOLIA;
    if (usdcAddress) {
      try {
        const [decimals, usdcBalanceRaw] = await Promise.all([
          client.readContract({
            address: usdcAddress as `0x${string}`,
            abi: USDC_ABI,
            functionName: 'decimals',
          }),
          client.readContract({
            address: usdcAddress as `0x${string}`,
            abi: USDC_ABI,
            functionName: 'balanceOf',
            args: [addressToQuery],
          }),
        ]);

        usdc = formatUnits(usdcBalanceRaw, Number(decimals));
      } catch (erc20Err) {
        console.warn('USDC balance fetch failed, returning 0:', erc20Err);
        usdc = '0';
      }
    }

    console.log('addressToQuery', addressToQuery);

    return NextResponse.json({
      address: addressToQuery,
      eth,
      usdc,
    });
  } catch (error) {
    console.error('Balance fetch error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({
      address: null,
      eth: '0',
      usdc: '0',
      warning: message,
    });
  }
}
