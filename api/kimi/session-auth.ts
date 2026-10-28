import * as cookie from "cookie";
import { Session } from "@contracts/constants";
import { verifySessionToken } from "./session";
import { findUserByUnionId } from "../queries/users";
import type { User } from "@db/schema";

/**
 * Strict session authentication — the single source of truth for resolving
 * the caller's user from the session cookie.
 *
 * Security contract:
 *  - No cookie / invalid cookie / unknown user  => throws (caller decides 401)
 *  - Disabled accounts (isActive = false)       => throws
 *  - NO demo-user fallback, ever. The legacy
 *    demo fallback in ./auth is dead code.
 */
export async function authenticateSession(headers: Headers): Promise<User> {
  const cookies = cookie.parse(headers.get("cookie") || "");
  const token = cookies[Session.cookieName];
  if (!token) {
    throw new Error("Authentication required");
  }
  const claim = await verifySessionToken(token);
  if (!claim?.unionId) {
    throw new Error("Invalid session");
  }
  const user = await findUserByUnionId(claim.unionId);
  if (!user) {
    throw new Error("User not found");
  }
  if (!user.isActive) {
    throw new Error("Account disabled");
  }
  // AP1: carry the session's 2FA scope alongside the user row so
  // middleware can restrict setup-scoped admin sessions.
  (user as User & { authScope?: string }).authScope =
    claim.scope === "setup" ? "setup" : "full";
  return user;
}
