import { toUsdt } from "./limits";

/**
 * Step 12 — reload bonus offers. Config lives in the reload_offers
 * setting (admin-edited JSON). An offer: pct 10–20, wagering 1–3,
 * a minimum deposit (USDT equivalent), and a max bonus cap in the
 * DEPOSIT currency. Matching is pure so it is unit-testable and
 * shared by the opt-in endpoint and the approval hook.
 */

export interface ReloadOffer {
  id: string;
  nameEn: string;
  nameBn: string;
  pct: number;
  wagering: number;
  minDepositUsdt: number;
  maxBonus: number;
  currency: string; // deposit currency code, or "ANY"
  expiryDays: number;
  active: boolean;
}

export function saneOffer(raw: any): ReloadOffer | null {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  const pct = Number(raw.pct);
  const wagering = Number(raw.wagering);
  if (!(pct >= 10 && pct <= 20)) return null;
  if (!(wagering >= 1 && wagering <= 3)) return null;
  return {
    id: String(raw.id),
    nameEn: String(raw.nameEn ?? `Reload +${pct}%`),
    nameBn: String(raw.nameBn ?? raw.nameEn ?? `Reload +${pct}%`),
    pct,
    wagering,
    minDepositUsdt: Math.max(0, Number(raw.minDepositUsdt) || 0),
    maxBonus: Math.max(0, Number(raw.maxBonus) || 0),
    currency: String(raw.currency ?? "ANY").toUpperCase(),
    expiryDays: Math.max(1, Number(raw.expiryDays) || 30),
    active: raw.active !== false,
  };
}

export function activeOffers(rawSetting: unknown): ReloadOffer[] {
  if (!Array.isArray(rawSetting)) return [];
  return rawSetting.map(saneOffer).filter((o): o is ReloadOffer => !!o && o.active);
}

/** The offer applies to this deposit? Returns the bonus in micro. */
export function reloadBonusMicro(
  offer: ReloadOffer,
  depositCurrency: string,
  depositMicro: bigint,
): bigint | null {
  if (offer.currency !== "ANY" && offer.currency !== depositCurrency.toUpperCase()) return null;
  const usdtEq = toUsdt(Number(depositMicro) / 1e8, depositCurrency);
  if (usdtEq < offer.minDepositUsdt) return null;
  let bonus = (depositMicro * BigInt(Math.round(offer.pct * 100))) / 10000n;
  const capMicro = BigInt(Math.round(offer.maxBonus * 1e8));
  if (bonus > capMicro) bonus = capMicro;
  return bonus > 0n ? bonus : null;
}
