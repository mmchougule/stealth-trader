import { describe, it, expect } from "vitest";
import {
  lamportsToSolStr,
  shortMint,
  formatAmount,
  formatHoldDuration,
  pad2,
  formatNum,
  rugcheckBadge,
} from "./format.js";

describe("lamportsToSolStr", () => {
  it("renders 0 as 0.0000", () => {
    expect(lamportsToSolStr(0n)).toBe("0.0000");
  });
  it("renders 1 SOL as 1.0000", () => {
    expect(lamportsToSolStr(1_000_000_000n)).toBe("1.0000");
  });
  it("renders fractional amounts at the requested decimals", () => {
    expect(lamportsToSolStr(123_456_789n, 9)).toBe("0.123456789");
    expect(lamportsToSolStr(123_456_789n, 4)).toBe("0.1234");
  });
  it("keeps the sign for negatives", () => {
    expect(lamportsToSolStr(-1_500_000_000n, 1)).toBe("-1.5");
  });
});

describe("shortMint", () => {
  it("leaves a short string alone", () => {
    expect(shortMint("ABC")).toBe("ABC");
  });
  it("truncates a long string with an ellipsis", () => {
    expect(shortMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")).toBe("DezXAZ…B263");
  });
});

describe("formatAmount", () => {
  it("returns the raw string when decimals=0", () => {
    expect(formatAmount("1000", 0)).toBe("1000");
  });
  it("inserts a decimal point and trims trailing zeros", () => {
    expect(formatAmount("1500000", 6)).toBe("1.5");
  });
  it("pads shorter raw amounts with leading zeros", () => {
    expect(formatAmount("1", 6)).toBe("0.000001");
  });
});

describe("formatHoldDuration", () => {
  it("renders seconds, minutes, hours, days", () => {
    expect(formatHoldDuration(45)).toBe("45s");
    expect(formatHoldDuration(60)).toBe("1m");
    expect(formatHoldDuration(3600)).toBe("1h");
    expect(formatHoldDuration(3600 + 30 * 60)).toBe("1h 30m");
    expect(formatHoldDuration(86_400 + 6 * 3600)).toBe("1d 6h");
  });
});

describe("pad2", () => {
  it("left-pads single digits with a zero", () => {
    expect(pad2(0)).toBe("00");
    expect(pad2(9)).toBe("09");
    expect(pad2(23)).toBe("23");
  });
});

describe("formatNum", () => {
  it("suffixes thousands and millions", () => {
    expect(formatNum(2_500_000)).toBe("2.50M");
    expect(formatNum(1_500)).toBe("1.50K");
  });
  it("uses 2 places for >=1 and 6 for sub-1", () => {
    expect(formatNum(12.3456)).toBe("12.35");
    expect(formatNum(0.001234)).toBe("0.001234");
  });
});

describe("rugcheckBadge", () => {
  it("says unknown when there's no score", () => {
    expect(rugcheckBadge(undefined)).toBe("rugcheck: unknown");
  });
  it("maps score ranges to safe / caution / high risk", () => {
    expect(rugcheckBadge(0)).toMatch(/safe \(0\)/);
    expect(rugcheckBadge(5_000)).toMatch(/caution \(5000\)/);
    expect(rugcheckBadge(20_000)).toMatch(/HIGH RISK \(20000\)/);
  });
});
