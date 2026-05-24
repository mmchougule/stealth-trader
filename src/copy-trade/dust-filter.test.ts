import { describe, it, expect } from "vitest";
import { isDust, resolveMin, DEFAULT_DUST_MIN_LAMPORTS } from "./dust-filter.js";

describe("isDust", () => {
  it("returns true when leaderAmountIn < minLamports", () => {
    expect(isDust({ leaderAmountIn: 1_999_999n, minLamports: 2_000_000n })).toBe(true);
  });
  it("returns false at the boundary", () => {
    expect(isDust({ leaderAmountIn: 2_000_000n, minLamports: 2_000_000n })).toBe(false);
  });
  it("returns false for larger trades", () => {
    expect(isDust({ leaderAmountIn: 1_000_000_000n, minLamports: 2_000_000n })).toBe(false);
  });
});

describe("resolveMin", () => {
  it("uses default when both env and follow override are unset", () => {
    expect(resolveMin({})).toBe(DEFAULT_DUST_MIN_LAMPORTS);
  });
  it("env value overrides default", () => {
    expect(resolveMin({ envValue: "5000000" })).toBe(5_000_000n);
  });
  it("follow override beats env", () => {
    expect(resolveMin({ envValue: "5000000", followOverride: 10_000_000n })).toBe(10_000_000n);
  });
  it("ignores bad env values", () => {
    expect(resolveMin({ envValue: "not-a-number" })).toBe(DEFAULT_DUST_MIN_LAMPORTS);
  });
  it("ignores zero/negative overrides", () => {
    expect(resolveMin({ followOverride: 0n })).toBe(DEFAULT_DUST_MIN_LAMPORTS);
  });
});
