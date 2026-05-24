/**
 * Setup wizard input validators. Every error path here is something a
 * first-time user will hit; failing loudly with a useful message is the
 * difference between "got bot running in 30s" and "rage-quit on step 2".
 */
import { describe, it, expect } from "vitest";
import {
  validateTelegramToken,
  validateHeliusKey,
  validateTgUserList,
  generateWebhookSecret,
} from "./validate.js";

describe("validateTelegramToken", () => {
  it("accepts a BotFather-shaped token", () => {
    const r = validateTelegramToken("1234567890:AAEhBP8wTAj1234567890abcdefghij_KLM");
    expect(r.ok).toBe(true);
  });

  it("rejects empty input", () => {
    expect(validateTelegramToken("").ok).toBe(false);
    expect(validateTelegramToken("   ").ok).toBe(false);
  });

  it("rejects a string without the colon shape", () => {
    expect(validateTelegramToken("just-some-garbage").ok).toBe(false);
  });

  it("rejects bot_id 0", () => {
    const r = validateTelegramToken("0:AAEhBP8wTAj1234567890abcdefghij_KLM");
    expect(r.ok).toBe(false);
  });

  it("rejects a token whose secret is too short", () => {
    const r = validateTelegramToken("123:short");
    expect(r.ok).toBe(false);
  });

  it("trims whitespace", () => {
    const r = validateTelegramToken("  123:AAEhBP8wTAj1234567890abcdefghij_KLM  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.startsWith(" ")).toBe(false);
  });
});

describe("validateHeliusKey", () => {
  it("accepts a UUIDv4-shaped key", () => {
    const r = validateHeliusKey("00000000-0000-4000-8000-000000000000");
    expect(r.ok).toBe(true);
  });

  it("rejects empty input", () => {
    expect(validateHeliusKey("").ok).toBe(false);
  });

  it("rejects short input", () => {
    expect(validateHeliusKey("short-key").ok).toBe(false);
  });

  it("rejects input missing hyphens", () => {
    expect(validateHeliusKey("00000000000040008000000000000000deadbeef").ok).toBe(false);
  });
});

describe("validateTgUserList", () => {
  it("accepts a single numeric ID", () => {
    const r = validateTgUserList("1773601358");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("1773601358");
  });

  it("accepts a comma list with whitespace", () => {
    const r = validateTgUserList("123, 456 ,789");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("123,456,789");
  });

  it("dedupes repeated IDs", () => {
    const r = validateTgUserList("123,123,456");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("123,456");
  });

  it("rejects an empty list", () => {
    expect(validateTgUserList("").ok).toBe(false);
    expect(validateTgUserList(",,").ok).toBe(false);
  });

  it("rejects non-numeric entries", () => {
    expect(validateTgUserList("123,abc").ok).toBe(false);
  });

  it("rejects 0", () => {
    expect(validateTgUserList("0").ok).toBe(false);
  });
});

describe("generateWebhookSecret", () => {
  it("returns hex of the bytes provided", () => {
    const fixed = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    expect(generateWebhookSecret(() => fixed)).toBe("deadbeef0102");
  });

  it("never produces uppercase or non-hex chars", () => {
    const rand = () => new Uint8Array(32).fill(0xff);
    const s = generateWebhookSecret(rand);
    expect(s).toMatch(/^[0-9a-f]+$/);
    expect(s.length).toBe(64);
  });
});
