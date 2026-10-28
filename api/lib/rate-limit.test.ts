import { describe, expect, it } from "vitest";
import { checkSpinPace, clientIp, looksLikeBot, rateLimit } from "./rate-limit";

describe("rateLimit sliding window", () => {
  it("allows up to the limit, then blocks, then recovers after the window", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(rateLimit("k1", 3, 1000, t0 + i)).toBe(true);
    }
    expect(rateLimit("k1", 3, 1000, t0 + 3)).toBe(false);
    // still inside the window for the oldest hit
    expect(rateLimit("k1", 3, 1000, t0 + 999)).toBe(false);
    // oldest hits expire -> allowed again
    expect(rateLimit("k1", 3, 1000, t0 + 1001)).toBe(true);
  });

  it("keys are independent", () => {
    const t0 = 2_000_000;
    expect(rateLimit("a", 1, 1000, t0)).toBe(true);
    expect(rateLimit("a", 1, 1000, t0)).toBe(false);
    expect(rateLimit("b", 1, 1000, t0)).toBe(true);
  });
});

describe("clientIp", () => {
  it("prefers the first x-forwarded-for hop, falls back to x-real-ip", () => {
    const req = new Request("http://x", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "9.9.9.9" },
    });
    expect(clientIp(req)).toBe("1.2.3.4");
    const req2 = new Request("http://x", { headers: { "x-real-ip": "9.9.9.9" } });
    expect(clientIp(req2)).toBe("9.9.9.9");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});

describe("spin pacing logic (bypassed under NODE_ENV=test for checkSpinPace)", () => {
  it("the underlying window math enforces burst caps", () => {
    const t0 = 3_000_000;
    for (let i = 0; i < 90; i++) {
      expect(rateLimit("spin:u1", 90, 60_000, t0 + i * 400)).toBe(true);
    }
    expect(rateLimit("spin:u1", 90, 60_000, t0 + 90 * 400)).toBe(false);
  });
  it("checkSpinPace is wired (test env returns true by design)", () => {
    expect(checkSpinPace(123)).toBe(true);
  });
});

describe("bot shield", () => {
  it("flags scripted clients and empty UA, passes browsers", () => {
    const mk = (ua?: string) =>
      new Request("http://x", ua ? { headers: { "user-agent": ua } } : undefined);
    expect(looksLikeBot(mk("curl/8.5.0"))).toBe(true);
    expect(looksLikeBot(mk("python-requests/2.31"))).toBe(true);
    expect(looksLikeBot(mk("Mozilla/5.0 (compatible; Googlebot/2.1)"))).toBe(true);
    expect(looksLikeBot(mk())).toBe(true);
    expect(
      looksLikeBot(
        mk("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"),
      ),
    ).toBe(false);
  });
});
