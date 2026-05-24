import { describe, it, expect } from "vitest";
import { handleWebhook } from "./webhook-handler.js";
import { WSOL_MINT } from "./types.js";
import type { CopyOutcome, Follow } from "./types.js";

const LEADER = "LeaderWallet";
const MINT = "MintXYZ";

function buyTx(sig: string, leader = LEADER) {
  return {
    signature: sig, slot: 1, feePayer: leader, type: "SWAP", source: "JUPITER",
    events: {},
    nativeTransfers: [{ fromUserAccount: leader, toUserAccount: "X", amount: 100_000_000 }],
    tokenTransfers: [{
      fromUserAccount: "X", toUserAccount: leader, mint: MINT,
      tokenAmount: 1, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
    }],
  };
}

function makeDeps(authSecret = "good-secret", followsArr: Follow[] = []) {
  const inserted: CopyOutcome[] = [];
  return {
    inserted,
    deps: {
      authSecret,
      follows: {
        async activeForLeader(w: string) { return followsArr.filter((f) => f.leaderWallet === w && f.active); },
        async alreadyLogged() { return false; },
        async insertLog(r: CopyOutcome) { inserted.push(r); },
        async dailySpent() { return 0n; },
        async dailyBudget() { return 1_000_000_000n; },
      },
      trade: {
        async executeBuy(args: { tgId: number; mint: string; solLamports: bigint }) {
          return { ok: true as const, txSignature: `sig-${args.tgId}`, tokensReceived: 1n };
        },
      },
    },
  };
}

describe("handleWebhook", () => {
  it("rejects missing/wrong Authorization header", async () => {
    const { deps } = makeDeps("expected");
    expect((await handleWebhook({ headers: {}, body: [] }, deps)).status).toBe(401);
    expect((await handleWebhook({ headers: { Authorization: "wrong" }, body: [] }, deps)).status).toBe(401);
  });

  it("rejects non-array body with 400", async () => {
    const { deps } = makeDeps();
    const r = await handleWebhook({ headers: { authorization: "good-secret" }, body: {} }, deps);
    expect(r.status).toBe(400);
  });

  it("processes an empty batch with 200/processed=0", async () => {
    const { deps } = makeDeps();
    const r = await handleWebhook({ headers: { authorization: "good-secret" }, body: [] }, deps);
    expect(r.status).toBe(200);
    expect(r.body.processed).toBe(0);
    expect(r.body.outcomes).toEqual([]);
  });

  it("dispatches one outcome per matching follow per matching tx", async () => {
    const followsArr: Follow[] = [
      { id: 1, followerTg: 1001, leaderWallet: LEADER, perTradeLamports: 3_000_000n, active: true },
      { id: 2, followerTg: 1002, leaderWallet: LEADER, perTradeLamports: 3_000_000n, active: true },
    ];
    const { inserted, deps } = makeDeps("good-secret", followsArr);
    const r = await handleWebhook({
      headers: { authorization: "good-secret" },
      body: [buyTx("tx-1"), buyTx("tx-2")],
    }, deps);
    expect(r.status).toBe(200);
    expect(r.body.processed).toBe(2);
    expect(inserted).toHaveLength(4); // 2 follows × 2 txs
    expect(r.body.outcomes!.every((o) => o.status === "success")).toBe(true);
  });

  it("silently drops non-swap-shaped txs in a batch", async () => {
    const followsArr: Follow[] = [
      { id: 1, followerTg: 1001, leaderWallet: LEADER, perTradeLamports: 3_000_000n, active: true },
    ];
    const transferOnly = {
      signature: "transfer-only", slot: 1, feePayer: LEADER, type: "TRANSFER",
      events: {},
      nativeTransfers: [{ fromUserAccount: LEADER, toUserAccount: "X", amount: 100_000 }],
      tokenTransfers: [], // no token in → not a buy
    };
    const { inserted, deps } = makeDeps("good-secret", followsArr);
    const r = await handleWebhook({
      headers: { authorization: "good-secret" },
      body: [transferOnly, buyTx("real-buy")],
    }, deps);
    expect(r.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].leaderSig).toBe("real-buy");
  });
});

// Silences the unused-import warning when WSOL_MINT moves around during edits.
void WSOL_MINT;
