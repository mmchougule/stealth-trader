import { describe, it, expect, beforeEach } from "vitest";
import { withUserSerial, _resetUserLocks } from "./userLock.js";

describe("withUserSerial", () => {
  beforeEach(() => _resetUserLocks());

  it("runs a single call to completion", async () => {
    expect(await withUserSerial(1, async () => 42)).toBe(42);
  });

  it("serializes concurrent calls for the same tgId", async () => {
    const log: string[] = [];
    const slow = withUserSerial(1, async () => {
      await delay(20); log.push("a-end"); return "a";
    });
    const fast = withUserSerial(1, async () => {
      log.push("b-start"); return "b";
    });
    const [a, b] = await Promise.all([slow, fast]);
    expect(a).toBe("a"); expect(b).toBe("b");
    // 'b-start' must not happen until after slow finished.
    expect(log).toEqual(["a-end", "b-start"]);
  });

  it("does NOT serialize calls for different tgIds", async () => {
    const log: string[] = [];
    const a = withUserSerial(1, async () => { await delay(30); log.push("a"); });
    const b = withUserSerial(2, async () => { await delay(5); log.push("b"); });
    await Promise.all([a, b]);
    // Different ids — fast one finishes first.
    expect(log).toEqual(["b", "a"]);
  });

  it("does not poison the queue when a prior call throws", async () => {
    await expect(withUserSerial(1, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withUserSerial(1, async () => 99)).toBe(99);
  });

  it("propagates a thrown error to the caller (only)", async () => {
    const a = withUserSerial(1, async () => { throw new Error("a"); });
    const b = withUserSerial(1, async () => "b");
    await expect(a).rejects.toThrow("a");
    expect(await b).toBe("b");
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
