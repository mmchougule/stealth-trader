# stealth-trader

**Trade on Solana without your wallet appearing in the swap transaction.**

stealth-trader is an open-source Telegram bot + MCP server for private Solana trading — use it in Telegram, or drive it from Claude Code, Cursor, or any MCP runtime. You deposit SOL once into the [b402 shielded pool](https://github.com/mmchougule/b402-solana); after that, buys, sells, lends, and cashouts are executed by a relayer over zero-knowledge proofs. The trade still lands on-chain — but the signer is the relayer, not your wallet.

[Get started](#get-started) · [What it does](#what-it-does) · [MCP tools](#mcp-tools) · [How it works](#how-it-works) · [Security](SECURITY.md)

![MCP](https://img.shields.io/badge/MCP-compatible-7C3AED) ![ci](https://github.com/mmchougule/stealth-trader/actions/workflows/ci.yml/badge.svg) ![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue) ![node: 20+](https://img.shields.io/badge/node-20+-339933) ![tests: 194](https://img.shields.io/badge/tests-194%20passing-green)

<table>
  <tr>
    <td align="center" valign="top" width="60%">
      <img src="docs/demo.gif" alt="terminal smoke — pnpm smoke runs shield + swap + cashout on Solana mainnet in ~25s" /><br/>
      <sub><b>Terminal:</b> <code>pnpm smoke</code> — a mainnet shield → swap → cashout in ~25 seconds. Prints Solscan links so you can verify the depositor wallet is absent from <code>tx.accountKeys</code>.</sub>
    </td>
    <td align="center" valign="top" width="40%">
      <img src="docs/tg-demo.gif" alt="hosted Telegram bot — buy a token, then verify on-chain the wallet isn't in the swap tx" /><br/>
      <sub><b>Telegram (hosted bot):</b> buy a token, then verify on-chain that the swap tx's <code>accountKeys</code> don't include your wallet. <a href="https://github.com/mmchougule/stealth-trader/releases/download/v0.4.0/stealth-trader-demo-1.mp4">Full MP4</a>.</sub>
    </td>
  </tr>
</table>

## Get started

**Use it from an agent** (Claude Code, Cursor, any MCP runtime):

```bash
claude mcp add stealth-trader \
  -e MASTER_SEED=$(openssl rand -hex 32) \
  -e HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY" \
  -e STEALTH_TG_ID=1 \
  -- npx -y @b402ai/stealth-trader@latest mcp
```

- `MASTER_SEED` derives your wallet — **back up the value `claude mcp add` stores; lose it, lose the funds.** (`openssl rand -hex 32` mints a fresh one.)
- `STEALTH_TG_ID` is just a numeric account namespace — any integer works for solo use.
- `HELIUS_RPC_URL` — free key at [helius.dev](https://helius.dev).

Your agent can now **buy, sell, check holdings, and cash out — privately**. Ask it: *"privately buy 0.01 SOL of `<mint>`, then cash out to a fresh address."* It composes the tools and signs nothing with your own wallet — the relayer does.

**See it on mainnet — ~25s, costs ~$0.01:**

```bash
git clone https://github.com/mmchougule/stealth-trader && cd stealth-trader
pnpm install
export HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"   # free at helius.dev
pnpm smoke
```

Needs a Solana CLI wallet with ~0.005 SOL — the script auto-funds the test wallet from `~/.config/solana/id.json` (or fund the address it prints). It shields, swaps, and cashes out, then prints two Solscan links: your wallet is **not** in the swap's `accountKeys`. ([full steps + exact cost ↓](#try-it-in-30-seconds))

**Or use the hosted Telegram bot:** [t.me/btrader021bot](https://t.me/btrader021bot) — `/start`, send a little SOL, Buy. This repo ships v0.5 (`/buy`, `/sell`, `/cashout`, `/holdings`, leader discovery, MCP); `/follow` lands in v0.6.

## What it does (v0.5)

| feature | what it is | how to use |
|---|---|---|
| **Private buy** | Buy any SPL token through Jupiter. Your wallet never signs the swap; the relayer does. Rug-check gate aborts obvious honeypots before any SOL moves. | TG `/buy <mint> <sol>` · MCP `private_buy` · `pnpm smoke` |
| **Private sell** | Sell a shielded token note back to SOL — same privacy property as buy. | TG `/sell <mint> <amount>` |
| **Private cashout** | Withdraw shielded balance to any wallet. The recipient has no on-chain edge to your deposit address. | TG `/cashout <addr>` · MCP `cashout` |
| **Private holdings** | Per-mint shielded balance — only the viewing-key holder can read it. | TG `/holdings` · MCP `get_holdings` |
| **Private lend** | Deposit shielded USDC into Kamino V2 for yield. Deposit address absent on chain. | MCP `private_lend` (mainnet) |
| **Leader stats / discovery** | 7-day PnL, hit rate, top mints for any wallet; curated starter list. Read-only in v0.5. | TG `/leader <wallet>`, `/discover` · MCP `discover_leaders` |

Seven MCP tools an agent can compose: *"check this wallet's 7-day stats, then privately buy 0.01 SOL of its top mint, and cash out to a fresh address."* The agent calls `discover_leaders` → `private_buy` → `cashout` — every trade signed by the relayer, your wallet never in `tx.accountKeys`.

**Copy-trade (`/follow`) ships in v0.6** — it needs a hosted Helius webhook proxy so self-hosters don't need ngrok. The full copy-trade bot is live now at [t.me/btrader021bot](https://t.me/btrader021bot) if you want to try that flow today.

## Why it matters

On Solana, the wallet that signs your swap is your wallet — so every trade is stamped with your address in public. Anyone can front-run your buys, copy your positions in real time, read your whole portfolio from a single address, and watch exactly when you exit.

stealth-trader breaks that link: a relayer signs the trade, not you, so there's nothing to correlate. Don't take our word for it — open any tx the bot produces on Solscan and your deposit address is not in `tx.accountKeys`. The bot's "Verify privacy" button shows you that, per trade.

## Try it in 30 seconds

```bash
git clone https://github.com/mmchougule/stealth-trader && cd stealth-trader
pnpm install
export HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
pnpm smoke
```

**Try it before any Telegram setup** — the smoke needs a Helius RPC URL + a funded Solana CLI wallet, runs on mainnet in ~25 seconds, and proves the privacy property end-to-end.

Here's exactly what happens, no surprises:

1. Generates a `MASTER_SEED` into `./.env` (back this up if you keep using it)
2. Derives a test wallet from that seed
3. **Transfers 0.0045 SOL from your Solana CLI wallet** (`~/.config/solana/id.json`) to the test wallet. The script previews this with a 5-second Ctrl-C window. Opt out: `STEALTH_NO_AUTOFUND=1` + fund the printed address manually.
4. Shields 0.0015 SOL into the b402 pool. *Your test wallet signs this — the one on-chain step where you're visible.*
5. Swaps shielded SOL → USDC. *Relayer signs; your wallet isn't in the swap tx.*
6. Cashes the USDC out — back to your CLI wallet by default. *Relayer signs; your wallet isn't in the cashout tx either.*

The script prints two Solscan links. Open both: the test wallet address doesn't appear in `accountKeys` for the swap or the cashout. That's the privacy property, verifiable on chain. ([How it works on-chain →](https://docs.b402.ai/solana/concepts/privacy-model))

**Net cost: ~$0.01** in tx fees + a few cents of swap slippage. The 0.0015 SOL becomes ~0.13 USDC and comes back to your CLI wallet at the cashout — nothing is drained.

No Solana CLI keypair? The script prints the deposit address and waits 5 minutes for you to fund it manually.

## Use cases

| audience | how they use it | result |
|---|---|---|
| **Solana trader** (Telegram) | `/buy <mint> <sol>` to enter, `/sell` to exit, `/cashout <addr>` to withdraw to a fresh wallet | trades land shielded; cashout has no on-chain link to the deposit |
| **AI agent** (MCP) | One prompt composes `discover_leaders` → `private_buy` → `get_holdings` → `cashout` | agent runs a private DeFi strategy with no wallet attribution |
| **App developer** (TypeScript SDK) | `import { B402Solana } from '@b402ai/solana'` and drive the same primitives directly | embed private execution into your own product |

Same code, three surfaces.

## Install

**As an MCP server (Claude Code, Cursor, any MCP runtime):**

```bash
claude mcp add stealth-trader -- npx -y @b402ai/stealth-trader@latest mcp
```

Env: `STEALTH_TG_ID`, `MASTER_SEED`, `HELIUS_RPC_URL`. Data persists to a local pglite store at `~/.stealth-trader/db` — set `DATABASE_URL=postgresql://…` to point at a real cluster.

For more MCP-side wiring (Claude Code, Cursor configs, prompt patterns): [b402 MCP overview →](https://docs.b402.ai/solana/mcp/overview).

**As a self-hosted Telegram bot:**

```bash
git clone https://github.com/mmchougule/stealth-trader && cd stealth-trader
pnpm install
pnpm wizard                       # paste bot token + Helius key
pnpm start                       # schema auto-applies on first boot
```

Get a bot token from [@BotFather](https://t.me/botfather) and a free Helius key from [helius.dev](https://helius.dev). The bot ships with pglite (WASM Postgres) in-process, so the only thing you need to provision is the bot itself.

For production deployments, set `OPERATOR_FEE_KEYPAIR_PATH` to a keypair file with ~0.05 SOL on hand. It absorbs the one-time ~0.002 SOL rent per (recipient, mint) on `/cashout` so users never see "insufficient funds for rent" the first time they withdraw to a fresh address.

## Usage (Telegram)

```
/start                            welcome + your deposit address
/wallet                           your deposit address (where to send SOL)
/balance                          public SOL balance you can spend

/buy <mint> <sol>                 private buy — shield fresh SOL and swap
/sell <mint> <raw-amount>         private sell — swap a token note back to SOL
/holdings                         per-mint shielded balances

/leader <wallet>                  7-day stats — PnL, hit rate, top mints
/discover                         curated leaders (paste any into /leader)

/cashout <recipient> [mint]       unshield to any wallet (no link to deposit)
```

Copy-trade (`/follow`, `/follows`, `/unfollow`) lands in v0.6 once the hosted Helius webhook proxy ships — until then end-users would need ngrok to receive leader events.

## MCP tools

Seven tools an agent (Claude Code, Cursor, custom) can compose. Example: *"score this wallet's last 7 days, privately buy 0.01 SOL of its top mint, then cash out to a fresh address."*

| tool                  | what it does                                                          |
|-----------------------|------------------------------------------------------------------------|
| `private_buy`         | swap SOL → any SPL token through the shielded pool                    |
| `private_lend`        | lend a shielded token into Kamino (mainnet only)                      |
| `cashout`             | unshield to a recipient with no on-chain link to your deposit         |
| `get_holdings`        | shielded token balances per mint                                      |
| `get_wallet`          | your deposit address (where you shield SOL once)                      |
| `get_balance`         | public SOL balance available for new shields                          |
| `discover_leaders`    | rank candidate wallets by recent on-chain PnL + activity              |

## How it works

```
Your wallet  ─shield once──►  shielded note (yours, hidden balance + owner)
                                       │
                ┌──────────────────────┼──────────────────────┐
                ▼                      ▼                      ▼
          private_buy            private_sell           private_lend
          (SOL → token)          (token → SOL)          (Kamino USDC)
                │                      │                      │
                └──────────┬───────────┴──────────┬───────────┘
                           ▼                      ▼
                  b402 relayer signs        new shielded note
                  the on-chain tx           (yours, still hidden)
```

Every action after the initial shield is built as an adapt proof: input is one of your shielded notes, output is a new shielded note, signer is the b402 relayer. The on-chain tx shows the relayer paying from a pool-controlled account. Your wallet is not a signer, not an account, not in the block.

Deeper reading on the b402 docs site:
- [Privacy model](https://docs.b402.ai/solana/concepts/privacy-model) — exactly what's hidden, what's revealed
- [Trust assumptions](https://docs.b402.ai/solana/concepts/trust-assumptions) — what the relayer can and can't do
- [Protocol architecture](https://docs.b402.ai/solana/protocol/architecture) — circuits, nullifier tree, verifier
- [Adapter overview](https://docs.b402.ai/solana/adapters/overview) — how Jupiter/Kamino integrate

Two correctness properties worth knowing — both ship in `@b402ai/solana@0.0.33`:
- **Swap routes ladder down on tx-size overrun.** Jupiter routes vary trade-to-trade; some exceed the relayer's tx-build buffer ("encoding overruns Uint8Array"). The swap layer retries at `maxAccounts` [32, 28, 24, 20] until the wrapped tx fits, then surfaces a clean error if none do.
- **Note leafIndex comes from the pool's `CommitmentAppended` event log, not the pre-tx `tree.leafCount` prediction.** Concurrent shields on the shared pool race the prediction. Reading the post-confirm event eliminates the phantom-note class that produces silent `Adapt_221` proof failures.

## Compared to

vs. public DEX routers (Jupiter, Raydium UI, etc.):

| property                                       | stealth-trader | public router |
|------------------------------------------------|:--------------:|:-------------:|
| your wallet signs the swap?                    | no             | yes           |
| your wallet appears in `tx.accountKeys`?       | no             | yes           |
| your portfolio is readable from your address?  | no             | yes           |
| wallet trackers can link the trade to you?     | no             | yes           |

vs. copy-trade bots (Trojan, BullX, Photon, Maestro):

| property                                          | stealth-trader | Trojan / BullX / Photon |
|---------------------------------------------------|:--------------:|:-----------------------:|
| follower's wallet appears in the leader's block?  | no             | yes                     |
| MCP-callable (any agent runtime)?                 | yes            | no                      |
| open source?                                      | yes            | no                      |

The "wallet in accountKeys" rows are facts checkable on Solscan in 30 seconds for any tx those tools produce.

## Numbers

- 194 unit tests covering swap-ladder, rug-check gate, Jupiter quote breaker, per-user serial lock, balance ledger, wallet derivation, delta-balance deposits, leader stats, MCP handlers.
- Tests run against in-memory pglite + a mocked SDK; ~3s wall time. A few exercise live Jupiter/RugCheck and degrade gracefully when rate-limited, so the suite stays green offline.
- Built on `@b402ai/solana@0.0.33`, mainnet program `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y`.

## Status

v0.5 — `/buy`, `/sell`, `/holdings`, `/cashout` work end-to-end against mainnet (TG + MCP); `/leader` and `/discover` are read-only stats. Every trade is relayer-signed; the user wallet never appears in the swap or cashout `accountKeys`. Copy-trade (`/follow`) lands in v0.6 with a hosted webhook proxy.

## Limits

- Copy-trade is buys only. Sells (leader sells X → follower sells X) ship with copy-trade in v0.6.
- Hosted b402 relayer is the default. Run your own from [`mmchougule/b402-solana/packages/relayer`](https://github.com/mmchougule/b402-solana/tree/main/packages/relayer) and point `B402_RELAYER_URL` at it.
- The b402 shielded pool is unaudited. Read the [trust assumptions](https://docs.b402.ai/solana/concepts/trust-assumptions) before depositing more than you'd lose in an experiment.
- Same-amount notes pile up if every copy uses identical `per_trade_lamports`. The SDK recycles existing notes when shapes match. Snap-to-nearest recycle is on the roadmap.

## Security

Reports: see [SECURITY.md](SECURITY.md). 90-day coordinated disclosure.

## Stack

- [`@b402ai/solana`](https://www.npmjs.com/package/@b402ai/solana) — shielded pool SDK
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP transport
- [`grammy`](https://github.com/grammyjs/grammY) — Telegram bot framework
- [`zod`](https://github.com/colinhacks/zod) — MCP tool schema validation
- [`pino`](https://github.com/pinojs/pino) — structured logging
- [`pg`](https://github.com/brianc/node-postgres) — Postgres driver
- Helius enhanced webhooks for leader-tx ingestion

## License

Apache-2.0.
