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

## User-Scoped 0G Chat Memory

Chat memory is persisted per user namespace and reused across sessions:

- Namespace format: `privy:<userId>:wallet:<address>`
- Primary key: `chat_summary_latest`
- Storage backend: 0G file storage (with local fallback in hybrid mode)

`/api/chat` flow:

1. **Pre-read memory** using `zg_storage_get_memory` with `userId` + key.
2. **Inject compact memory context** into the OpenAI system prompt (`User Memory Context`).
3. **Post-write updated summary** to `chat_summary_latest` with a bounded schema (`v2`) for token-safe reuse.

This enables user-specific recall after logout/login, as long as the same Privy user account is used.

### 0G SDK patch (Galileo testnet)

The npm package `@0glabs/0g-ts-sdk` (v0.3.3) ships an ABI that does not match the current 0G Galileo testnet contract: the on-chain `Submission` struct includes an `address submitter` field. We apply a post-install patch so `flow.submit` uses the correct selector (`0xbc8c11f8`).

- **Automatic:** `postinstall` runs `scripts/patch-0g-sdk.js` after every `yarn` or `npm install`.
- **Manual:** `yarn patch:0g` or `npm run patch:0g` to re-run the patch (e.g. after reinstalling the SDK).

Patch reference: [MattWong-ca/ethdenver-2026](https://github.com/MattWong-ca/ethdenver-2026/blob/main/templates/storage/scripts/patch-0g-sdk.js).

## Diagnostics

Preflight health endpoint:

- `GET /api/test-0g-preflight`

Write/read smoke test endpoint:

- `POST /api/test-0g-write-read`

User namespace alignment check:

- `POST /api/test-0g-get-memory` (now passes `userId` namespace)

Inference+storage integration e2e check:

- `GET /api/test-zg-inference-storage-e2e`
  - writes `chat_summary_latest`
  - calls `zg_inference_chat` with the same `userId`
  - returns `storedChatContext` in response for verification

Low-level flow submit diagnostics script:

```bash
corepack yarn diag:0g-submit
```

This script captures chain/indexer/node context and submit/upload failure details for debugging `flow.submit` reverts. After applying the 0G SDK patch (see above), submits should succeed on Galileo testnet.
