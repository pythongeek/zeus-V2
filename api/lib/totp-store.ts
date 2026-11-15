import { getSqliteClient } from "../queries/connection";

/**
 * P6-03: atomically consume a TOTP time-step for a user.
 *
 * A code matches for a +/-1 step window (~90 s); without persistence the
 * same code could be presented repeatedly. The compare-and-set keeps only a
 * strictly increasing counter, so a replay (or a second login with a code
 * already used) is rejected. Returns false when the step was already used.
 */
export function consumeTotpCounter(userId: number, counter: number): boolean {
  const res = getSqliteClient()
    .prepare(
      "UPDATE users SET last_totp_counter = ? WHERE id = ? AND (last_totp_counter IS NULL OR last_totp_counter < ?)",
    )
    .run(counter, userId, counter);
  return res.changes === 1;
}
