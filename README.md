<p align="center">
  <img src="docs/demo.gif" alt="stealth-trader demo — Solscan view of a mirror tx with no follower wallet in the account list" width="720"/>
</p>

# stealth-trader

**Private copy-trading for Solana — `/follow <wallet>` and every mirrored trade lands in a shielded note signed by a relayer, not your wallet. Photon / BullX / Trojan alternative.**

Telegram bot + MCP server. Built on the [b402 shielded pool](https://github.com/mmchougule/b402-solana) (Solana mainnet program `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y`).

[Quickstart](#install) · [How it works](#how-it-works) · [MCP tools](#mcp-tools) · [Demo](#demo) · [Security](SECURITY.md)

![ci](https://github.com/mmchougule/stealth-trader/actions/workflows/ci.yml/badge.svg) ![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue) ![node: 20+](https://img.shields.io/badge/node-20+-339933) ![tests: 133](https://img.shields.io/badge/tests-133%20passing-green)

## Why this exists

Every other Solana copy-trade bot — Trojan, BullX, Photon, Maestro, Bonkbot — copies a leader's trade by sending an identical swap from the follower's wallet right after the leader's. The follower's address ends up in the same swap, the same block, indexed by every wallet tracker and leaderboard forever. The set of followers for any popular wallet is public.

stealth-trader breaks that. The follower shields once into the b402 pool. When the leader buys, the bot constructs an adapt proof: input is one of the follower's shielded notes, output is a new shielded note holding the bought token, signer is the b402 relayer. The on-chain swap shows the relayer paying from a pool-controlled account. The follower's wallet is never a signer, never an account, never on chain in that block.

## Install

**As an MCP server (Claude Code, Cursor, any MCP runtime):**

```bash
claude mcp add stealth-trader -- npx -y @b402ai/stealth-trader@latest mcp
```

Set these in your MCP env: `STEALTH_TG_ID`, `MASTER_SEED`, `HELIUS_RPC_URL`, `DATABASE_URL`.

**As a self-hosted Telegram bot:**

```bash
git clone https://github.com/mmchougule/stealth-trader && cd stealth-trader
pnpm install
pnpm setup                       # interactive: paste bot token + Helius key
docker compose up -d postgres
psql $DATABASE_URL -f sql/001_init.sql
psql $DATABASE_URL -f sql/002_balances.sql
pnpm start
```

You need: a Telegram bot token from [@BotFather](https://t.me/botfather), a free Helius API key from [dev.helius.dev](https://dev.helius.dev), Docker for Postgres.

## Usage (Telegram)

```
/start                            show your derived deposit address
/wallet                           same, just the address
/balance                          public SOL balance the bot can spend
/follow <wallet> <sol>            start mirroring a leader at <sol> per buy
/follows                          list active follows
/unfollow <wallet>                stop mirroring
/holdings                         shielded balances per mint  (v0.4)
/cashout <sol> <recipient>        unshield to a fresh address  (v0.4)
```

## MCP tools

Same operations, agent-callable. An agent can compose them: "find the top 5 wallets making money on memecoins this week, follow each at 0.005 SOL." It calls `discover_leaders` then `follow` five times.

| tool                  | what it does                                                          |
|-----------------------|------------------------------------------------------------------------|
| `get_wallet`          | returns the user's deposit address                                    |
| `get_balance`         | public SOL balance available to the bot                               |
| `get_holdings`        | shielded token balances (v0.4)                                        |
| `follow`              | start mirroring a leader at N SOL per buy                             |
| `unfollow`            | stop mirroring                                                        |
| `list_follows`        | active follows                                                        |
| `private_buy`         | direct private buy of a mint                                          |
| `discover_leaders`    | rank candidate wallets by recent on-chain PnL + activity              |
| `cashout`             | unshield to a recipient with no on-chain link to the depositor (v0.4) |

## How it works

```
Leader buys on Solana    →    Helius webhook    →    stealth-trader bot
                                                            │
                                          parseSwap (sum on-chain transfers)
                                                            │
                                                dust filter + follow lookup
                                                            │
                                          b402 SDK: shield → swap → note
                                                            │
                                            DB insert + Telegram/MCP reply
```

Two key correctness properties:
- **Amounts come from on-chain transfer arrays, not Helius's `events.swap` enrichment.** Helius mis-reports `nativeInput.amount` for some Jupiter-routed pump.fun trades (priority-fee leg instead of main wSOL leg). We sum native + wSOL transfers out of the leader's address — ground truth.
- **Note leafIndex comes from the pool's `CommitmentAppended` event log, not the pre-tx `tree.leafCount` prediction.** Concurrent shields on the shared pool race the prediction. Reading the post-confirm event eliminates the phantom-note class that produces silent `Adapt_221` proof failures.

Both fixes ship in `@b402ai/solana@0.0.33`. Full architecture in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Compared to

| property                                          | stealth-trader | Trojan / BullX / Photon |
|---------------------------------------------------|:--------------:|:-----------------------:|
| follower's wallet signs the mirror swap?          | no             | yes                     |
| follower's wallet appears in the leader's block?  | no             | yes                     |
| can be driven from an MCP-speaking agent?         | yes            | no                      |
| open source?                                      | yes            | no                      |

The first two rows are facts about `tx.accountKeys`. Verifiable on Solscan in 30 seconds for any tx those bots produce.

## Numbers

- 133 unit tests covering parse-swap, dust filter, copy orchestrator, webhook reconciler, per-user serial lock, balance ledger, wallet derivation, deposits, MCP handlers.
- Zero network calls in the test suite — ~250ms wall time.
- Built on `@b402ai/solana@0.0.33`, mainnet program `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y`.

## Status

v0.3 — Telegram surface + MCP server wired against `@b402ai/solana`. The SwapBackend dispatches real `sdk.swap` calls. Buys land in shielded notes today; `/cashout` and `/holdings` ship in v0.4 once the devnet integration suite is wired.

## Limits

- Buys only. Sells (leader sells X → follower sells X) are spec'd; not in v0.3.
- Hosted b402 relayer is the default. Run your own from [`mmchougule/b402-solana/packages/relayer`](https://github.com/mmchougule/b402-solana/tree/main/packages/relayer) and point `B402_RELAYER_URL` at it.
- b402 shielded pool is unaudited.
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
