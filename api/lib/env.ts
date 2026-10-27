import "dotenv/config";

function getEnvVar(name: string, fallback = ""): string {
  if (typeof process !== "undefined" && process.env?.[name]) {
    return process.env[name]!;
  }
  return fallback;
}

export const env = {
  appId: getEnvVar("APP_ID", "zeus-app-id"),
  appSecret: getEnvVar("APP_SECRET", "zeus-app-secret-key-32-chars-long"),
  isProduction: typeof process !== "undefined" ? process.env?.NODE_ENV === "production" : true,
  databaseUrl: getEnvVar("DATABASE_URL", ""),
  kimiAuthUrl: getEnvVar("KIMI_AUTH_URL", "https://auth.kimi.com"),
  kimiOpenUrl: getEnvVar("KIMI_OPEN_URL", "https://open.kimi.com"),
  ownerUnionId: getEnvVar("OWNER_UNION_ID", ""),
};
