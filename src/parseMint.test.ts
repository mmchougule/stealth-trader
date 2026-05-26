import { describe, it, expect } from "vitest";
import { parseMintFromInput } from "./parseMint.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("parseMintFromInput", () => {
  it("returns null for null/undefined/empty/non-string", () => {
    expect(parseMintFromInput(null)).toBe(null);
    expect(parseMintFromInput(undefined)).toBe(null);
    expect(parseMintFromInput("")).toBe(null);
    expect(parseMintFromInput(123 as unknown as string)).toBe(null);
  });

  it("returns the mint when passed a bare base58 address", () => {
    expect(parseMintFromInput(BONK)).toBe(BONK);
  });

  it("extracts mint from common URL shapes", () => {
    expect(parseMintFromInput(`https://pump.fun/coin/${BONK}`)).toBe(BONK);
    expect(parseMintFromInput(`https://solscan.io/token/${USDC}`)).toBe(USDC);
    expect(parseMintFromInput(`https://birdeye.so/token/${USDC}?chain=solana`)).toBe(USDC);
    expect(parseMintFromInput(`https://dexscreener.com/solana/${BONK}`)).toBe(BONK);
    expect(parseMintFromInput(`https://jup.ag/swap/SOL-${USDC}`)).toBe(USDC);
  });

  it("extracts mint from a KOL-style sentence", () => {
    expect(parseMintFromInput(`aping ${BONK} send it`)).toBe(BONK);
  });

  it("returns null when the input has no base58 substring of length 32-44", () => {
    expect(parseMintFromInput("hello world")).toBe(null);
    // Non-base58 chars (0, O, I, l) keep the run too short.
    expect(parseMintFromInput("0".repeat(40))).toBe(null);
  });

  it("rejects substrings shorter than 32 or longer than 44 base58 chars", () => {
    expect(parseMintFromInput("1".repeat(31))).toBe(null);
    // A 64-byte tx signature is ~88 base58 chars — should NOT match.
    const sig = "5".repeat(88);
    expect(parseMintFromInput(sig)).toBe(null);
  });
});
