# stealth-trader

**Copy-trade Solana leaders. Your wallet stays off-chain.**

A Telegram bot that mirrors trades from any Solana wallet into your own private balance. The trades land in a shielded note, signed by a relayer — your address is never on the same transaction as the leader's, never in the same block, never indexed alongside them.

Built on the [b402 shielded pool](https://github.com/mmchougule/b402-solana) (Solana mainnet, program `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y`).

## How it differs from other copy-trade bots

Every other Solana copy-trader sends an identical swap from your wallet right after the leader's. Your address ends up in the same swap, the same block, indexed by every wallet tracker and leaderboard forever. The leader's followers are a public set.

stealth-trader does not send a swap from your wallet. You shield SOL into the b402 pool once. When the leader buys a token, the bot constructs an adapt proof — input: one of your shielded notes, output: a new shielded note holding the bought token, signer: the b402 relayer. The on-chain swap shows the relayer paying from a pool-controlled account. Your wallet is not a signer, not an account, not on chain in that block. The next leader trade compounds inside the pool the same way.

## Install

```
git clone https://github.com/b402-ai/stealth-trader
cd stealth-trader
pnpm install
pnpm setup           # interactive — paste bot token + Helius key, get .env
docker compose up -d postgres
psql $DATABASE_URL -f sql/001_init.sql
pnpm start
```

You need:
- A Telegram bot token from [@BotFather](https://t.me/botfather)
- A free Helius API key from [dev.helius.dev](https://dev.helius.dev)
- A Solana keypair file (default: `~/.config/solana/id.json`)
- Docker for Postgres (or your own Postgres pointed at by `DATABASE_URL`)

## Usage

In Telegram, send your bot:

```
/follow <leader-wallet> 0.005   # follow a wallet, copy at 0.005 SOL per leader buy
/follows                         # list active follows
/unfollow <leader-wallet>        # stop copying
/buy <mint>                      # manual private buy
/holdings                        # show shielded balance
/cashout <amount> <recipient>    # unshield to any address
```

## Architecture

```
Leader buys on Solana  →  Helius webhook  →  stealth-trader bot
                                                      │
                                  parseSwap (extract amount + mint)
                                                      │
                                            dust filter, follow lookup
                                                      │
                                       b402 SDK: shield → swap → note
                                                      │
                                  Postgres copy_trades_log + Telegram DM
```

The bot itself is stateful (Postgres for follows + log) but stateless per-tx — every copy is a fresh `pnpm setup`-time wallet derivation through `@b402ai/solana`'s SDK.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full flow.

## Development

```
pnpm dev             # bot with hot reload
pnpm test            # vitest
pnpm typecheck       # tsc --noEmit
pnpm build           # emit dist/
```

The full test suite (parse-swap, dust-filter, setup validators) runs in under 200ms with no I/O. Integration tests against a real Postgres are in `test/integration/` and need `DATABASE_URL` to point at a disposable DB.

## Stack

- [`@b402ai/solana`](https://www.npmjs.com/package/@b402ai/solana) — shielded pool SDK
- [`grammy`](https://github.com/grammyjs/grammY) — Telegram bot framework
- [`pino`](https://github.com/pinojs/pino) — structured logging
- [`pg`](https://github.com/brianc/node-postgres) — Postgres driver
- Helius enhanced webhooks for leader-tx ingestion

## Limits and caveats

- Buys only. Sells (`leader sells X → follower sells X`) are spec'd but not shipped; the bot's `/cashout` covers the manual case.
- Hosted b402 relayer is the default. You can run your own from [`b402-ai/b402-solana/packages/relayer`](https://github.com/mmchougule/b402-solana/tree/main/packages/relayer) and point `B402_RELAYER_URL` at it.
- b402 shielded pool is unaudited.
- Same-amount notes can pile up if every copy uses identical `per_trade_lamports`. The SDK recycles existing notes when shapes match. A "snap to nearest" recycle is on the roadmap.

## Status

The hosted bot (private deployment) has been running on Solana mainnet since 2026-05-23. The public OSS build in this repo is `v0.1.0` — initial cut, untested by anyone except the authors. Issues and PRs are welcome.

## Security

Reports: see [SECURITY.md](SECURITY.md).

## License

Apache-2.0.
