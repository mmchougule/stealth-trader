/**
 * Per-TG-user token holdings ledger. Source of truth for who-owns-what
 * inside the shielded pool — the pool itself only sees one commingled
 * balance owned by the relayer.
 *
 * Every mutation is transactional via withTx: the buy path must
 * atomically (a) credit user tokens, (b) recompute average cost basis,
 * and (c) append a trades row. A crash between (a) and (c) would
 * silently lose history — the BEGIN/COMMIT keeps the three in lockstep.
 */
import { q, withTx } from "./db/index.js";
import { log } from "./log.js";

export interface Holding {
  tg_id: bigint;
  mint: string;
  amount: string;
  decimals: number;
  symbol: string | null;
  avg_cost_lamports: bigint;
  total_invested_lamports: bigint;
}

export async function getHolding(tgId: number, mint: string): Promise<Holding | undefined> {
  const res = await q<Holding>(
    `SELECT tg_id, mint, amount, decimals, symbol, avg_cost_lamports, total_invested_lamports
     FROM stealth.holdings
     WHERE tg_id = $1 AND mint = $2`,
    [tgId, mint],
  );
  return res.rows[0];
}

export async function listHoldings(tgId: number): Promise<Holding[]> {
  const res = await q<Holding>(
    `SELECT tg_id, mint, amount, decimals, symbol, avg_cost_lamports, total_invested_lamports
     FROM stealth.holdings
     WHERE tg_id = $1 AND amount > 0
     ORDER BY total_invested_lamports DESC`,
    [tgId],
  );
  return res.rows;
}

/**
 * Credit a buy: upsert the holding row, recompute average cost basis,
 * append a trades row. Three statements, one BEGIN/COMMIT.
 */
export async function recordBuy(args: {
  tgId: number;
  mint: string;
  symbol: string | null;
  decimals: number;
  solLamports: bigint;
  tokensReceived: bigint;
  feeLamports: bigint;
  txSignature: string;
}): Promise<void> {
  await withTx(async (client) => {
    await client.query(
      `INSERT INTO stealth.holdings (tg_id, mint, amount, decimals, symbol,
                                     avg_cost_lamports, total_invested_lamports, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, NOW())
       ON CONFLICT (tg_id, mint) DO UPDATE
         SET amount = stealth.holdings.amount + EXCLUDED.amount,
             total_invested_lamports = stealth.holdings.total_invested_lamports + EXCLUDED.total_invested_lamports,
             symbol = COALESCE(EXCLUDED.symbol, stealth.holdings.symbol),
             updated_at = NOW()`,
      [
        args.tgId, args.mint, args.tokensReceived.toString(), args.decimals, args.symbol,
        args.solLamports.toString(),
      ],
    );

    // Scaling by 1e9 keeps the integer-divided avg_cost_lamports stable for
    // tokens with up to 9 decimals; consumers divide back when displaying.
    await client.query(
      `UPDATE stealth.holdings
       SET avg_cost_lamports = CASE
         WHEN amount > 0 THEN (total_invested_lamports * 1000000000)::bigint / amount::bigint
         ELSE 0
       END
       WHERE tg_id = $1 AND mint = $2`,
      [args.tgId, args.mint],
    );

    await client.query(
      `INSERT INTO stealth.trades (tg_id, side, mint, symbol, sol_lamports,
                                   token_amount, token_decimals, fee_lamports, tx_signature)
       VALUES ($1, 'buy', $2, $3, $4, $5, $6, $7, $8)`,
      [
        args.tgId, args.mint, args.symbol, args.solLamports.toString(),
        args.tokensReceived.toString(), args.decimals, args.feeLamports.toString(),
        args.txSignature,
      ],
    );
  });

  log.info(
    {
      tgId: args.tgId, mint: args.mint,
      tokensReceived: args.tokensReceived.toString(),
      solSpent: args.solLamports.toString(),
      sig: args.txSignature,
    },
    "recorded buy",
  );
}

/**
 * Debit a sell. The amount-CHECK constraint rejects oversell at the
 * row level (UPDATE returns rowCount 0 — we surface InsufficientTokenBalance
 * so the caller can refund the swap on the API side too).
 */
export async function recordSell(args: {
  tgId: number;
  mint: string;
  symbol: string | null;
  decimals: number;
  tokensSold: bigint;
  solReceived: bigint;
  feeLamports: bigint;
  txSignature: string;
}): Promise<void> {
  await withTx(async (client) => {
    const upd = await client.query(
      `UPDATE stealth.holdings
       SET amount = amount - $3,
           updated_at = NOW()
       WHERE tg_id = $1 AND mint = $2 AND amount >= $3`,
      [args.tgId, args.mint, args.tokensSold.toString()],
    );
    if (upd.rowCount === 0) throw new Error("InsufficientTokenBalance");

    await client.query(
      `INSERT INTO stealth.trades (tg_id, side, mint, symbol, sol_lamports,
                                   token_amount, token_decimals, fee_lamports, tx_signature)
       VALUES ($1, 'sell', $2, $3, $4, $5, $6, $7, $8)`,
      [
        args.tgId, args.mint, args.symbol, args.solReceived.toString(),
        args.tokensSold.toString(), args.decimals, args.feeLamports.toString(),
        args.txSignature,
      ],
    );
  });

  log.info(
    {
      tgId: args.tgId, mint: args.mint,
      tokensSold: args.tokensSold.toString(),
      solReceived: args.solReceived.toString(),
      sig: args.txSignature,
    },
    "recorded sell",
  );
}
