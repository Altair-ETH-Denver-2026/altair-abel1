# Altair DeFi (Sepolia + 0G)

Altair is a Next.js app that integrates:
- Privy embedded wallets
- Uniswap Trading API on Ethereum Sepolia
- 0G storage actions with resilient fallback behavior

## Run Locally

```bash
corepack yarn dev
```

App runs at `http://localhost:3000`.

## Core Environment Variables

### Privy
- `NEXT_PUBLIC_PRIVY_APP_ID`
- `PRIVY_APP_SECRET`
- `PRIVY_VERIFICATION_KEY`
- `PRIVY_WALLET_AUTH_PRIVATE_KEY` (must be a valid `wallet-auth:...` value)

### Uniswap / Chain
- `UNISWAP_API_KEY`
- `ETH_SEPOLIA_RPC_URL`

### 0G
- `ZG_PRIVATE_KEY`
- `ZG_RPC_URL`
- `ZG_INDEXER_RPC`
- `ZG_NETWORK`

## 0G Storage Modes

`zgStorageActionProvider` supports runtime mode selection:

- `ZG_STORAGE_MODE=onchain_0g`  
  Attempt only on-chain 0G file storage.
- `ZG_STORAGE_MODE=hybrid` (default)  
  Attempt on-chain first, then fallback to local cache when unavailable.
- `ZG_STORAGE_MODE=local_only`  
  Skip on-chain writes and use local cache only.

Related controls:

- `ZG_ENABLE_LOCAL_FALLBACK=true|false`
- `ZG_CIRCUIT_BREAKER_THRESHOLD` (default `3`)
- `ZG_CIRCUIT_BREAKER_COOLDOWN_MS` (default `300000`)
- `ZG_LOCAL_FALLBACK_PATH` (default `.cache/zg-memory-fallback.json`)
- `ZG_LOCAL_INDEX_PATH` (default `.cache/zg-storage-index.json`)

## Diagnostics

Preflight health endpoint:

- `GET /api/test-0g-preflight`

Write/read smoke test endpoint:

- `POST /api/test-0g-write-read`

Low-level flow submit diagnostics script:

```bash
corepack yarn diag:0g-submit
```

This script captures chain/indexer/node context and submit/upload failure details for debugging `flow.submit` reverts.
