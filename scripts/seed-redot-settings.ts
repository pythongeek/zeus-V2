// Seed the RedotPay rail settings (Deposit v2, owner 2026-10-30).
// Run: npx tsx scripts/seed-redot-settings.ts (from /opt/zeus-slot)
import { createRequire } from "node:module";
(globalThis as any).require = createRequire(import.meta.url);

const settings = await import("../api/lib/settings");
settings.setSetting("redot_pay_id", "1210819625");
settings.setSetting("redot_qr_image", "/assets/redotpay-qr.png");
console.log("redot_pay_id =", settings.getSetting("redot_pay_id"));
console.log("redot_qr_image =", settings.getSetting("redot_qr_image"));
console.log("redot_pay_name =", JSON.stringify(settings.getSetting("redot_pay_name")));
