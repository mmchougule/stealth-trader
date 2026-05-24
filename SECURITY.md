# Security

## Reporting

Please report vulnerabilities privately to **security@b402.dev**. We'll
acknowledge within 72 hours and aim to ship a fix within 14 days for
high-severity issues. Coordinated disclosure timeline is 90 days from
acknowledgement; we'll publish details after a fix is in production.

Do not file public GitHub issues for security reports.

## Scope

In scope:
- The bot's webhook handler (`src/copy-trade/`) — anything that lets a
  third party trigger spurious copies, drain a user's balance, or read
  data they shouldn't.
- The setup wizard (`src/setup/`) — anything that leaks the bot token,
  Helius key, or follower wallet via the generated `.env` or its logs.
- The SQL schema (`sql/`) — privilege-escalation or data-leak issues.

Out of scope:
- The b402 shielded pool itself. Report there:
  https://github.com/mmchougule/b402-solana/blob/main/SECURITY.md
- Solana validator / RPC bugs.
- Telegram protocol issues.
- Issues that require an attacker to already control a follower's bot
  token or Postgres credentials.

## Threat model summary

The bot's threat model and trust assumptions are:

- The hosted b402 relayer is trusted to not censor or front-run, but
  cannot spend user notes (it never sees spending keys). Anyone can run
  their own relayer.
- The Helius RPC is trusted for tx data freshness. A malicious Helius
  could withhold leader events or feed forgeries; the latter is caught
  because the bot re-derives swap amounts from on-chain transfer arrays.
- The Postgres database is trusted to not be tampered with by an
  external attacker.
- The Telegram channel is trusted as the authenticated user surface;
  bot tokens leaking compromises the per-bot deployment.

For the full b402 protocol trust model see
https://docs.b402.dev/architecture/trust-assumptions.
