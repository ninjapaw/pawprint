import { describe, expect, it, vi } from "vitest";
import { cached } from "./cache.js";

describe("bounded source cache", () => {
  it("deduplicates simultaneous reads and expires observations", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => "observed");
      const cache = cached<string>(60000, 2);
      expect(await Promise.all([cache("fixed", read), cache("fixed", read)])).toEqual(["observed", "observed"]);
      expect(read).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60001);
      await cache("fixed", read);
      expect(read).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("does not reuse rejected promises as a success fallback", async () => {
    const cache = cached<string>(60000);
    await expect(cache("fixed", async () => { throw new Error("unavailable"); })).rejects.toThrow("unavailable");
    expect(await cache("fixed", async () => "new observation")).toBe("new observation");
  });
});
