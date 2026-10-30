import { createRequire } from "module";
(globalThis as any).require = createRequire(import.meta.url);
const { getSqliteClient } = await import("../api/queries/connection");
const { getTripwireStatus } = await import("../api/lib/tripwire");
const client = getSqliteClient();
for (const m of getTripwireStatus(client)) {
  console.log(JSON.stringify({
    modeId: m.modeId, mu0: m.mu0, sigma0: m.sigma0,
    spinsSeen: m.spinsSeen, spinsPerDay: m.spinsPerDay,
    events: (m.events ?? []).length,
  }));
}
