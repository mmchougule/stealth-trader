/**
 * Deposit extractor contract:
 *   - native transfer IN to watched → counted, lamports summed
 *   - native transfer OUT from watched → ignored
 *   - self-transfer → ignored (no double-credit on tx that involves both)
 *   - tx slot <= sinceSlot → skipped (cursor guard)
 *   - empty nativeTransfers → empty result
 *
 * Pure-function tests, no DB. The DB-side cursor read/write is exercised
 * by the integration test in v0.3.
 */
import { describe, it, expect } from "vitest";
import { extractDeposits, cursorKey, type RawHeliusTx } from "./deposits.js";

const ME = "WatchedPubkeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "OtherPubkeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function tx(over: Partial<RawHeliusTx> = {}): RawHeliusTx {
  return { signature: "sig-x", slot: 100, type: "TRANSFER", source: "SYSTEM_PROGRAM", nativeTransfers: [], ...over };
}

describe("extractDeposits", () => {
  it("returns inbound transfers as deposits", async () => {
    const r = extractDeposits(
      [tx({ nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: ME, amount: 5_000_000 }] })],
      ME,
      0,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ toPubkey: ME, fromPubkey: OTHER, lamports: 5_000_000n, signature: "sig-x", slot: 100 });
  });

  it("ignores outbound transfers", () => {
    const r = extractDeposits(
      [tx({ nativeTransfers: [{ fromUserAccount: ME, toUserAccount: OTHER, amount: 5_000_000 }] })],
      ME,
      0,
    );
    expect(r).toEqual([]);
  });

  it("ignores self-transfers", () => {
    const r = extractDeposits(
      [tx({ nativeTransfers: [{ fromUserAccount: ME, toUserAccount: ME, amount: 5_000_000 }] })],
      ME,
      0,
    );
    expect(r).toEqual([]);
  });

  it("sums multiple inbound legs in the same tx", () => {
    const r = extractDeposits(
      [tx({ nativeTransfers: [
        { fromUserAccount: OTHER, toUserAccount: ME, amount: 1_000_000 },
        { fromUserAccount: "Third", toUserAccount: ME, amount: 2_000_000 },
        { fromUserAccount: ME, toUserAccount: OTHER, amount: 500_000 },
      ] })],
      ME,
      0,
    );
    expect(r).toHaveLength(1);
    expect(r[0].lamports).toBe(3_000_000n);
  });

  it("skips txs at or below the cursor", () => {
    const r = extractDeposits(
      [
        tx({ slot: 10, nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: ME, amount: 1 }] }),
        tx({ slot: 20, nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: ME, amount: 1 }] }),
      ],
      ME,
      15,
    );
    expect(r).toHaveLength(1);
    expect(r[0].slot).toBe(20);
  });

  it("returns [] for an empty batch", () => {
    expect(extractDeposits([], ME, 0)).toEqual([]);
  });

  it("returns [] when nativeTransfers is absent", () => {
    const r = extractDeposits([{ signature: "x", slot: 100 }], ME, 0);
    expect(r).toEqual([]);
  });
});

describe("cursorKey", () => {
  it("namespaces per tgId", () => {
    expect(cursorKey(1)).toBe("deposit_cursor:1");
    expect(cursorKey(123456)).toBe("deposit_cursor:123456");
  });
});
