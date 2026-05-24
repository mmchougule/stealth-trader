# Contributing

Thanks for considering a contribution. The project is small and the
bar for accepted PRs is mostly mechanical, not political.

## Local development

```
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest, ~200ms
pnpm dev           # bot with hot reload (needs .env from `pnpm setup`)
```

Postgres is needed for any DB-touching code. `docker compose up -d postgres`
starts one with the schema pre-applied (sql/ is mounted as init scripts).

## What we'll merge

- Bug fixes with a regression test.
- New copy-trade adapters (e.g. additional DEX-aware parsers under
  `src/copy-trade/parsers/`).
- Documentation improvements that match the engineering tone of the
  README (terse, no marketing).
- CI and developer-experience improvements that don't add a heavy
  toolchain dependency.

## What we won't merge without prior discussion

- Renaming public API surfaces in `src/copy-trade/` — they're exported
  for plugin authors.
- New runtime dependencies. Lockfile diffs are reviewed by hand; pull
  requests with 200 new transitive deps will be sent back.
- Telegram-channel-specific UX features (the bot is intentionally
  generic; opinionated UX belongs in a fork).

## Style

- TypeScript strict mode is on. No `any` unless you explain why in a
  comment.
- Tests live next to the code they cover as `*.test.ts`.
- Commit messages: `area: short summary` (e.g. `copy-trade: parse wSOL leg`).
  No emoji in commit messages or code.
- Public functions get a one-paragraph doc comment that names the
  invariants. Skip JSDoc on internal helpers.

## Triage

Issues are looked at within a few days, not in real time. If you need
a faster response, tag the maintainers in the issue body.
