# Architecture

This is the engineering doc: what each module does, where the trust
boundaries are, and how a copy-trade actually flows end to end.

## Module map

```
src/
├── bot.ts                  # entrypoint — wires Telegram + webhook + pipeline
├── cli.ts                  # `stealth-trader [setup|start]`
├── log.ts                  # pino logger
├── db/
│   └── index.ts            # Postgres pool + withTx helper
├── copy-trade/
│   ├── types.ts            # ParsedSwap, Follow, CopyOutcome, HeliusEnhancedTx
│   ├── parse-swap.ts       # Helius tx → ParsedSwap | null
│   ├── parse-swap.test.ts  # contract tests for the parser
│   ├── dust-filter.ts      # min-trade gate (default 0.002 SOL)
│   └── dust-filter.test.ts
└── setup/
    ├── index.ts            # interactive `pnpm setup`
    ├── validate.ts         # pure-function validators
    └── validate.test.ts
```

## The copy flow

```
Helius enhanced webhook
         │
         ▼
parseSwap(tx, leader_wallet)
   - feePayer must equal the leader
   - sums native + wSOL transfers OUT of the leader for amountIn
   - picks the largest non-wSOL token transferred IN as tokenOut
   - returns ParsedSwap | null
         │
         ▼
dust filter (default 0.002 SOL)
   - drops leader buys smaller than the gas-and-fee floor
         │
         ▼
follow lookup (Postgres)
   - finds active follows for this leader_wallet
   - reads each follower's per_trade_lamports
         │
         ▼
b402 SDK swap (one call per follower)
   - if a same-amount shielded note exists → recycle (no shield tx)
   - else → shield SOL into the pool, then swap
   - shield + swap both signed by the b402 relayer, NOT the follower
   - SDK reads the actual leafIndex from the CommitmentAppended event
         │
         ▼
copy_trades_log insert + Telegram DM to the follower
```

## Trust boundaries

```
                  ┌─────────────────────────┐
                  │  Solana / b402 pool      │   <- on-chain, trustless
                  │  program 42a3hsCX…       │
                  └────────────┬─────────────┘
                               │
   ┌───────────────────────────┼───────────────────────────┐
   │                           │                            │
┌──┴──┐               ┌────────┴────────┐          ┌────────┴────────┐
│ user│               │  stealth-trader │          │  b402 relayer    │
│ keys│               │  (this repo)    │          │  (b402-solana)   │
└─────┘               └────────┬────────┘          └─────────────────┘
                               │                            ▲
                               │                            │ submits txs
                               │  Helius webhook           │ signed by relayer
                               │  Postgres (follows)       │
                               │  Telegram bot token       │
                               ▼
                       OPERATOR-RUN — anyone can fork & host
```

- **The pool is trustless**: notes can only be spent with the holder's
  spending key. The relayer cannot drain them.
- **The relayer is liveness-trusted**: it can refuse to submit a tx,
  but it cannot forge one. You can run your own.
- **The bot's Postgres is operator-trusted**: anyone with DB access can
  see which Telegram user follows which leader (the bot's metadata),
  but cannot derive note plaintexts.

## On-chain visibility

```
Leader's wallet                Pool (b402)            Relayer-controlled accounts
      │                            │                            │
      │  swap tx (signed by leader)│                            │
      ├───────────────────────────►│                            │
      │                            │                            │
      │                            │   adapt_execute            │
      │                            │   (signed by relayer)      │
      │                            ├───────────────────────────►│
      │                            │   shielded-note input,     │
      │                            │   shielded-note output,    │
      │                            │   Jupiter swap inline      │
      │                            │                            │
      Follower's wallet appears in neither tx.
```

Both transactions are on chain. The leader's is on-chain-visible by
design — that's what we're observing. The follower's swap is on chain
too, but the only signer/account is the b402 relayer. There is no
on-chain edge from leader to follower.

## What's racy and how the SDK handles it

- **Shield-then-immediate-swap**: the indexer may lag behind chain by
  3–10s. The SDK retries `proveLeaf(leafIndex)` for up to 30s before
  giving up.
- **Concurrent shields on the shared pool**: the SDK reads the actual
  on-chain leafIndex from the `CommitmentAppended` event in the tx
  log, not the racy pre-tx `tree.leafCount` prediction. This is the
  fix shipped in `@b402ai/solana@0.0.33`.
- **Helius enrichment lies for pump.fun-via-Jupiter**: parseSwap
  ignores `events.swap` and sums actual on-chain transfer arrays.

## Storage shape

`stealth.follows` is the source of truth for who copies whom.
`stealth.copy_trades_log` is append-only — every webhook event for an
active follow produces exactly one row (success | skipped | failed).
The `UNIQUE (follow_id, leader_sig)` constraint dedupes Helius retries.
`stealth.system_config` holds singleton state like the Helius webhook
ID (so we don't create duplicates on each deploy).

See `sql/001_init.sql` for the actual definitions.
