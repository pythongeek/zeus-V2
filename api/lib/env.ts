import "dotenv/config";

function getEnvVar(name: string, fallback = ""): string {
  if (typeof process !== "undefined" && process.env?.[name]) {
    return process.env[name]!;
  }
  return fallback;
}

export const env = {
  appId: getEnvVar("APP_ID", "zeus-app-id"),
  appSecret: (() => {
    // F2: never fall back to a known secret — session signing depends on
    // this value. Production sets a 64-char APP_SECRET via .env.
    const v = getEnvVar("APP_SECRET", "");
    if (v.length < 32) {
      throw new Error("APP_SECRET env var is required (min 32 chars)");
    }
    return v;
  })(),
  isProduction: typeof process !== "undefined" ? process.env?.NODE_ENV === "production" : true,
  databaseUrl: getEnvVar("DATABASE_URL", ""),
  kimiAuthUrl: getEnvVar("KIMI_AUTH_URL", "https://auth.kimi.com"),
  kimiOpenUrl: getEnvVar("KIMI_OPEN_URL", "https://open.kimi.com"),
  ownerUnionId: getEnvVar("OWNER_UNION_ID", ""),
};
