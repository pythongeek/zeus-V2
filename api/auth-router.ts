import * as cookie from "cookie";
import { Session } from "@contracts/constants";
import { getSessionCookieOptions } from "./lib/cookies";
import { createRouter, authedQuery } from "./middleware";

/** Strip sensitive columns before any user object crosses the wire. */
function publicUser(user: {
  id: number;
  unionId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  avatar: string | null;
  role: string;
  totpEnabled?: boolean;
  authScope?: string;
}) {
  return {
    id: user.id,
    unionId: user.unionId,
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatar: user.avatar,
    role: user.role,
    // AP1: clients need these to route admins into 2FA setup / show
    // security state. The secret itself never crosses the wire.
    totpEnabled: !!user.totpEnabled,
    authScope: user.authScope === "setup" ? "setup" : "full",
  };
}

export const authRouter = createRouter({
  me: authedQuery.query((opts) => publicUser(opts.ctx.user)),
  logout: authedQuery.mutation(async ({ ctx }) => {
    const opts = getSessionCookieOptions(ctx.req.headers);
    ctx.resHeaders.append(
      "set-cookie",
      cookie.serialize(Session.cookieName, "", {
        httpOnly: opts.httpOnly,
        path: opts.path,
        sameSite: opts.sameSite?.toLowerCase() as "lax" | "none",
        secure: opts.secure,
        maxAge: 0,
      }),
    );
    return { success: true };
  }),
});
