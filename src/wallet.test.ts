/**
 * Wallet derivation contract:
 *   - same (tgId, masterSeed) → same Keypair (deterministic)
 *   - different tgId → different Keypair
 *   - different masterSeed → different Keypair
 *   - bad inputs throw with useful messages
 *
 * Hex parser rejects everything that isn't exactly 64 lowercase hex chars.
 */
import { describe, it, expect } from "vitest";
import { deriveUserKeypair, parseMasterSeed } from "./wallet.js";

const SEED_A = parseMasterSeed("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
const SEED_B = parseMasterSeed("01".repeat(32));

describe("deriveUserKeypair", () => {
  it("is deterministic for the same input", () => {
    const a = deriveUserKeypair(1, SEED_A);
    const b = deriveUserKeypair(1, SEED_A);
    expect(a.publicKey.toBase58()).toBe(b.publicKey.toBase58());
  });

  it("produces different keys for different tgIds", () => {
    const a = deriveUserKeypair(1, SEED_A);
    const b = deriveUserKeypair(2, SEED_A);
    expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
  });

  it("produces different keys for different masterSeeds", () => {
    const a = deriveUserKeypair(1, SEED_A);
    const b = deriveUserKeypair(1, SEED_B);
    expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
  });

  it("rejects masterSeed of wrong length", () => {
    expect(() => deriveUserKeypair(1, new Uint8Array(16))).toThrow(/32 bytes/);
  });

  it("rejects non-positive tgIds", () => {
    expect(() => deriveUserKeypair(0, SEED_A)).toThrow(/positive integer/);
    expect(() => deriveUserKeypair(-1, SEED_A)).toThrow(/positive integer/);
    expect(() => deriveUserKeypair(1.5, SEED_A)).toThrow(/positive integer/);
  });
});

describe("parseMasterSeed", () => {
  it("accepts 64 lowercase hex chars", () => {
    expect(parseMasterSeed("a".repeat(64))).toBeInstanceOf(Uint8Array);
  });

  it("accepts whitespace + uppercase", () => {
    const a = parseMasterSeed("  " + "DEADBEEF".repeat(8) + "  ");
    const b = parseMasterSeed("deadbeef".repeat(8));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(() => parseMasterSeed("abcd")).toThrow(/64 hex chars/);
    expect(() => parseMasterSeed("a".repeat(65))).toThrow(/64 hex chars/);
  });

  it("rejects non-hex characters", () => {
    expect(() => parseMasterSeed("g".repeat(64))).toThrow(/valid hex/);
  });
});
