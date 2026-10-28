export const Session = {
  cookieName: "kimi_sid",
  maxAgeMs: 30 * 24 * 60 * 60 * 1000, // F2: 30 days (was 365)
} as const;

export const ErrorMessages = {
  unauthenticated: "Authentication required",
  insufficientRole: "Insufficient permissions",
} as const;

export const Paths = {
  login: "/login",
  oauthCallback: "/api/oauth/callback",
} as const;
