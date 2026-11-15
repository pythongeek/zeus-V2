import { isIP } from "node:net";

/**
 * P6-11: alert webhooks are fetched by the app process. Restrict them to
 * public HTTPS endpoints so a settings value cannot probe loopback, RFC1918,
 * link-local/metadata or internal hostnames (SSRF).
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function assertSafeWebhookUrl(raw: string): URL {
  // Test-only escape hatch for the local capture server. Never set in prod.
  if (process.env.ZEUS_ALLOW_PRIVATE_WEBHOOKS === "1") {
    try { return new URL(raw); } catch { throw new Error("Webhook URL is not a valid URL"); }
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Webhook URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("Webhook URL must use https");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Webhook URL must be a public host");
  }
  const bare = host.replace(/^\[|\]$/g, "");
  const kind = isIP(bare);
  if (kind === 6) {
    if (bare === "::1" || bare.startsWith("fc") || bare.startsWith("fd") || bare.startsWith("fe80")) {
      throw new Error("Webhook URL must be a public host");
    }
  } else if (kind === 4) {
    if (isPrivateIpv4(bare)) throw new Error("Webhook URL must be a public host");
  } else if (!bare.includes(".")) {
    // single-label hostnames resolve inside the host/private network
    throw new Error("Webhook URL must be a public host");
  }
  return url;
}
