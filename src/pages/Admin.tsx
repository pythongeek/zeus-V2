import { trpc } from "@/providers/trpc";
import { useLang } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/useAuth";
import {
  Users, DollarSign, Trophy, Percent, ShieldCheck, ArrowLeft, RefreshCw,
  LayoutDashboard, CreditCard, Cog, Globe, ShieldAlert, Gift, ServerCog,
  FlaskConical, HeartPulse, BellRing, Download,
} from "lucide-react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { toast } from "sonner";
import { TotpSetup } from "@/components/TotpSetup";

// B3: Admin Game Config — every admin-controllable setting (B1/B2) edited
// in one card, grouped, with EN/BN labels from the API definitions, typed
// inputs (toggle / number / money / text / JSON), an RTP warning when math
// keys are dirty, and the recent-change audit trail underneath.
// P0.2 (admin-panel programme): the card is now section-aware — each
// admin section renders only its own setting groups, and the audit
// trail can stand alone in the System section.
const ALL_GROUPS = ["site", "bets", "features", "currencies", "presentation", "math", "security"];

/** Section I: system health, exports, alert channels. */
function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

function HealthCard({ enabled }: { enabled: boolean }) {
  const { t } = useLang();
  const q = trpc.admin.getSystemHealth.useQuery(undefined, { enabled, retry: false });
  const h: any = q.data;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex flex-wrap items-baseline gap-2 border-b border-slate-800/60 py-1.5">
      <span className="text-xs uppercase text-slate-500 w-36 shrink-0">{label}</span>
      <span className="text-sm text-slate-200">{value}</span>
    </div>
  );
  return (
    <Card className="bg-slate-900/80 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HeartPulse className="h-4 w-4 text-emerald-400" /> {t("healthTitle")}
          <span className="flex-1" />
          <Button size="sm" variant="outline" className="h-7 text-xs border-slate-700" onClick={() => q.refetch()}>
            {t("refreshBtn")}
          </Button>
        </CardTitle>
        <CardDescription className="text-slate-400">{t("healthDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading || !h ? (
          <p className="text-sm text-slate-500">{t("loading")}</p>
        ) : (
          <div>
            {row(t("hService"), (
              <span>
                <span className="text-emerald-400">●</span> {t("hRunning")} · {t("hUptime")}{" "}
                {Math.floor(h.service.uptimeSec / 3600)}h {Math.floor((h.service.uptimeSec % 3600) / 60)}m ·{" "}
                Node {h.service.nodeVersion}
              </span>
            ))}
            {row(t("hVersion"), (
              <span className="font-mono text-xs">
                {h.version.commit ?? "—"}
                {h.version.commitDate ? ` · ${new Date(h.version.commitDate).toLocaleString()}` : ""}
              </span>
            ))}
            {row(t("hDatabase"), <span className="font-mono text-xs">{fmtBytes(h.db.sizeBytes)}</span>)}
            {row(t("hDisk"), h.disk ? (
              <span className="font-mono text-xs">
                {fmtBytes(h.disk.free)} {t("hFreeOf")} {fmtBytes(h.disk.total)}
              </span>
            ) : "—")}
            {row(t("hBackup"), h.backup ? (
              <span className="text-xs">
                {h.backup.file} · {new Date(h.backup.at * 1000).toLocaleString()} · {fmtBytes(h.backup.sizeBytes)}
              </span>
            ) : t("hNoBackup"))}
            {row(t("hMonitor"), (
              <span className="text-xs">
                {h.monitor.failCount === 0
                  ? <span className="text-emerald-400">{t("hMonitorOk")}</span>
                  : <span className="text-red-400">{h.monitor.failCount} {t("hMonitorFailing")}</span>}
                {h.monitor.recent.length > 0 && (
                  <span className="block font-mono text-[11px] text-slate-500 mt-1">
                    {h.monitor.recent[h.monitor.recent.length - 1]}
                  </span>
                )}
              </span>
            ))}
            <div className="pt-3">
              <div className="text-xs uppercase text-slate-500 mb-1.5">{t("hErrors")}</div>
              {h.errors.length === 0 ? (
                <p className="text-xs text-emerald-400">{t("hNoErrors")}</p>
              ) : (
                <pre className="text-[11px] leading-relaxed text-red-300/80 bg-slate-950/60 border border-slate-800 rounded-lg p-3 overflow-x-auto max-h-56 overflow-y-auto whitespace-pre-wrap">
                  {h.errors.join("\n")}
                </pre>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ExportsCard({ enabled }: { enabled: boolean }) {
  const { t } = useLang();
  const [kind, setKind] = useState<"players" | "transactions" | "spins" | "settings_history">("players");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const exportM = trpc.admin.exportData.useMutation({
    onSuccess: (r: any) => {
      const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`${t("exportDone")}: ${r.rowCount}${r.truncated ? ` (${t("exportTruncated")})` : ""}`);
    },
    onError: (e: any) => toast.error(e.message),
  });
  if (!enabled) return null;
  const inputCls = "bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100";
  return (
    <Card className="bg-slate-900/80 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Download className="h-4 w-4 text-sky-400" /> {t("exportsTitle")}
        </CardTitle>
        <CardDescription className="text-slate-400">{t("exportsDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="text-xs text-slate-500 block">{t("exportKind")}</span>
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as any)}>
              <option value="players">{t("exportPlayers")}</option>
              <option value="transactions">{t("exportTransactions")}</option>
              <option value="spins">{t("exportSpins")}</option>
              <option value="settings_history">{t("exportSettingsHistory")}</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-500 block">{t("fromLbl")}</span>
            <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-500 block">{t("toLbl")}</span>
            <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <Button
            size="sm"
            className="h-9 bg-sky-600 hover:bg-sky-500 text-white font-semibold"
            disabled={exportM.isPending}
            onClick={() =>
              exportM.mutate({
                kind,
                ...(from ? { from } : {}),
                ...(to ? { to } : {}),
              })
            }
          >
            {exportM.isPending ? t("loading") : t("downloadCsv")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AlertChannelsCard({ enabled, canEdit }: { enabled: boolean; canEdit: boolean }) {
  const { t, lang } = useLang();
  const utils = trpc.useUtils();
  const { data: settingsList } = trpc.admin.getSettings.useQuery(undefined, { enabled, retry: false });
  const [webhook, setWebhook] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const saveM = trpc.admin.updateSettings.useMutation({
    onSuccess: async () => {
      toast.success(t("channelsSaved"));
      setWebhook(null);
      setChatId(null);
      await utils.admin.getSettings.invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const testM = trpc.admin.testAlertChannel.useMutation({
    onSuccess: (r: any) => {
      const parts: string[] = [];
      parts.push(
        r.webhook.configured
          ? `${t("chanWebhook")}: ${r.webhook.ok ? "OK" : r.webhook.error ?? `HTTP ${r.webhook.status}`}`
          : `${t("chanWebhook")}: ${t("chanNotSet")}`,
      );
      parts.push(
        r.telegram.configured
          ? `${t("chanTelegram")}: ${r.telegram.ok ? "OK" : r.telegram.error}`
          : `${t("chanTelegram")}: ${t("chanNotSet")}`,
      );
      toast.info(parts.join(" · "), { duration: 8000 });
    },
    onError: (e: any) => toast.error(e.message),
  });
  if (!enabled || !settingsList) return null;
  const current = (key: string) => String(settingsList.find((s: any) => s.key === key)?.value ?? "");
  const label = (s: any) => (lang === "bn" ? s.labelBn : s.labelEn);
  const whDef = settingsList.find((s: any) => s.key === "alert_webhook_url");
  const tgDef = settingsList.find((s: any) => s.key === "alert_telegram_chat_id");
  const inputCls = "w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100 font-mono";
  return (
    <Card className="bg-slate-900/80 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="h-4 w-4 text-amber-400" /> {t("channelsTitle")}
        </CardTitle>
        <CardDescription className="text-slate-400">{t("channelsDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {whDef && (
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">{label(whDef)}</span>
            <input
              className={inputCls}
              disabled={!canEdit}
              value={webhook ?? current("alert_webhook_url")}
              onChange={(e) => setWebhook(e.target.value)}
              placeholder="https://..."
            />
          </label>
        )}
        {tgDef && (
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">{label(tgDef)}</span>
            <input
              className={inputCls}
              disabled={!canEdit}
              value={chatId ?? current("alert_telegram_chat_id")}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="-100..."
            />
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button
              size="sm"
              className="h-8 text-xs bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold"
              disabled={saveM.isPending || (webhook === null && chatId === null)}
              onClick={() =>
                saveM.mutate({
                  entries: {
                    ...(webhook !== null ? { alert_webhook_url: webhook } : {}),
                    ...(chatId !== null ? { alert_telegram_chat_id: chatId } : {}),
                  },
                })
              }
            >
              {t("saveChanges")}
            </Button>
          )}
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs border-slate-700"
              disabled={testM.isPending}
              onClick={() => testM.mutate()}
            >
              {testM.isPending ? t("loading") : t("testChannelsBtn")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Section G: risk, reconciliation & alerts. */
function PromotionsSection({ enabled }: { enabled: boolean }) {
  const { t } = useLang();
  const [when, setWhen] = useState("");
  const [pool, setPool] = useState("2000");
  const [currency, setCurrency] = useState("BDT");
  const [maxClaims, setMaxClaims] = useState("100");
  const list = trpc.admin.listEnvelopes.useQuery(undefined, { enabled, refetchInterval: 15000 });
  const settlements = trpc.admin.listSettlements.useQuery({ limit: 20 }, { enabled });
  const schedule = trpc.admin.scheduleEnvelope.useMutation({
    onSuccess: () => {
      toast.success(t("envScheduledOk"));
      list.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const nowSec = Math.floor(Date.now() / 1000);
  const statusOf = (ts: number) => (nowSec < ts ? "scheduled" : nowSec <= ts + 300 ? "live" : "closed");
  return (
    <div className="space-y-4">
      <Card className="bg-slate-900/80 border-slate-800">
        <CardHeader>
          <CardTitle className="text-amber-400">{t("envFormTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="text-xs text-slate-400 space-y-1 block">
              <span>{t("envWhen")}</span>
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="bg-slate-800 border-slate-700" />
            </label>
            <label className="text-xs text-slate-400 space-y-1 block">
              <span>{t("envPool")}</span>
              <Input value={pool} onChange={(e) => setPool(e.target.value)} className="bg-slate-800 border-slate-700" />
            </label>
            <label className="text-xs text-slate-400 space-y-1 block">
              <span>BDT / USDT</span>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-md h-9 px-2 text-sm text-white">
                <option value="BDT">BDT</option>
                <option value="USDT">USDT</option>
              </select>
            </label>
            <label className="text-xs text-slate-400 space-y-1 block">
              <span>{t("envMaxClaims")}</span>
              <Input value={maxClaims} onChange={(e) => setMaxClaims(e.target.value)} className="bg-slate-800 border-slate-700" />
            </label>
          </div>
          <Button
            className="bg-amber-500 text-black hover:bg-amber-400"
            disabled={!when || schedule.isPending}
            onClick={() =>
              schedule.mutate({
                scheduledAt: Math.floor(new Date(when).getTime() / 1000),
                currency,
                poolAmount: pool,
                maxClaims: Math.max(1, parseInt(maxClaims) || 1),
              })
            }
          >
            {t("envScheduleBtn")}
          </Button>
          <p className="text-xs text-slate-500">Seed hash publishes immediately; the seed reveals after the drop closes. Daily budget applies (BDT equivalent).</p>
        </CardContent>
      </Card>
      <Card className="bg-slate-900/80 border-slate-800">
        <CardHeader>
          <CardTitle className="text-amber-400">{t("envListTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {(list.data?.envelopes ?? []).map((e: any) => (
            <div key={e.id} className="flex justify-between border-b border-slate-800 py-1">
              <span className="text-slate-300">
                #{e.id} · {new Date(e.scheduled_at * 1000).toLocaleString()} · {statusOf(e.scheduled_at)}
              </span>
              <span className="text-slate-400">
                {e.pool_amount} {e.currency} · {e.claims_count}/{e.max_claims} · claimed {e.claimed_total}
              </span>
            </div>
          ))}
          {(list.data?.envelopes ?? []).length === 0 && <div className="text-slate-500">—</div>}
        </CardContent>
      </Card>
      <Card className="bg-slate-900/80 border-slate-800">
        <CardHeader>
          <CardTitle className="text-amber-400">{t("envSettlementsTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {(settlements.data?.settlements ?? []).map((s: any) => (
            <div key={s.id} className="flex justify-between border-b border-slate-800 py-1">
              <span className="text-slate-300">{s.kind} · {s.email}</span>
              <span className="text-slate-400">
                {s.amount} {s.currency} · {new Date(s.period_start * 1000).toLocaleDateString()}
              </span>
            </div>
          ))}
          {(settlements.data?.settlements ?? []).length === 0 && <div className="text-slate-500">—</div>}
        </CardContent>
      </Card>
    </div>
  );
}

function RiskSection({
  enabled,
  onFocusPlayer,
}: {
  enabled: boolean;
  onFocusPlayer: (userId: number) => void;
}) {
  const { t } = useLang();
  const [alertFilter, setAlertFilter] = useState<"open" | "acknowledged" | "all">("open");
  const alertsQ = trpc.admin.getAlerts.useQuery(
    { status: alertFilter, limit: 50 },
    { enabled, retry: false },
  );
  const reconQ = trpc.admin.getReconciliation.useQuery(undefined, { enabled, retry: false });
  const signalsQ = trpc.admin.getRiskSignals.useQuery(undefined, { enabled, retry: false });

  const runM = trpc.admin.runReconciliation.useMutation({
    onSuccess: async (r: any) => {
      toast.success(`${t("reconDone")}: ${r.mismatchCount}`);
      await reconQ.refetch();
      await alertsQ.refetch();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const ackM = trpc.admin.ackAlert.useMutation({
    onSuccess: async () => { await alertsQ.refetch(); },
    onError: (e: any) => toast.error(e.message),
  });
  const resolveM = trpc.admin.resolveAlert.useMutation({
    onSuccess: async () => { await alertsQ.refetch(); },
    onError: (e: any) => toast.error(e.message),
  });

  const userChip = (u: any) => (
    <button
      key={u.id}
      className="text-amber-300 hover:text-amber-200 underline decoration-dotted underline-offset-2"
      onClick={() => onFocusPlayer(u.id)}
    >
      {u.name ?? u.email}
    </button>
  );

  const sevClass = (sev: string) =>
    sev === "critical"
      ? "bg-red-500/15 text-red-400 border-red-500/30"
      : "bg-amber-500/15 text-amber-400 border-amber-500/30";

  return (
    <div className="space-y-5">
      {/* Alerts inbox */}
      <Card className="bg-slate-900/80 border-slate-800">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-amber-400" /> {t("alertsInbox")}
            {alertsQ.data && alertsQ.data.openCount > 0 && (
              <Badge variant="secondary" className="bg-red-500/15 text-red-400 border-red-500/30">
                {alertsQ.data.openCount} {t("openWord")}
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="text-slate-400">{t("alertsInboxDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            {(["open", "acknowledged", "all"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={alertFilter === f ? "default" : "outline"}
                className={alertFilter === f ? "bg-amber-500 text-slate-950 hover:bg-amber-400 h-7 text-xs" : "border-slate-700 text-slate-300 h-7 text-xs"}
                onClick={() => setAlertFilter(f)}
              >
                {f === "open" ? t("filterOpen") : f === "acknowledged" ? t("filterAcked") : t("rangeAll")}
              </Button>
            ))}
          </div>
          {alertsQ.isLoading ? (
            <p className="text-sm text-slate-500">{t("loading")}</p>
          ) : !alertsQ.data || alertsQ.data.alerts.length === 0 ? (
            <p className="text-sm text-slate-500">{t("noAlerts")}</p>
          ) : (
            alertsQ.data.alerts.map((a: any) => (
              <div key={a.id} className="flex flex-wrap items-center gap-2 border border-slate-800/70 rounded-lg px-3 py-2 bg-slate-950/40 text-sm">
                <Badge variant="secondary" className={sevClass(a.severity)}>{a.kind}</Badge>
                <span className="text-slate-200">{a.title}</span>
                {a.ref_user_id && (
                  <button className="text-amber-300 text-xs underline decoration-dotted underline-offset-2" onClick={() => onFocusPlayer(a.ref_user_id)}>
                    #{a.ref_user_id}
                  </button>
                )}
                <span className="text-[11px] text-slate-600">{new Date(a.created_at * 1000).toLocaleString()}</span>
                <span className="flex-1" />
                {a.status === "open" && (
                  <Button size="sm" variant="outline" className="h-6 text-[11px] border-slate-700" onClick={() => ackM.mutate({ alertId: a.id })}>
                    {t("ackBtn")}
                  </Button>
                )}
                {a.status !== "resolved" && (
                  <Button size="sm" variant="outline" className="h-6 text-[11px] border-slate-700" onClick={() => resolveM.mutate({ alertId: a.id })}>
                    {t("resolveBtn")}
                  </Button>
                )}
                {a.status === "resolved" && <span className="text-[11px] text-emerald-400">{t("resolvedWord")}</span>}
                {a.status === "acknowledged" && <span className="text-[11px] text-slate-500">{t("filterAcked")}</span>}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Reconciliation */}
      <Card className="bg-slate-900/80 border-slate-800">
        <CardHeader>
          <CardTitle className="text-base">{t("reconTitle")}</CardTitle>
          <CardDescription className="text-slate-400">{t("reconDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button
              size="sm"
              className="h-8 text-xs bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold"
              disabled={runM.isPending}
              onClick={() => runM.mutate()}
            >
              {runM.isPending ? t("reconRunning") : t("runReconBtn")}
            </Button>
            {reconQ.data?.lastRun ? (
              <span className="text-xs text-slate-400">
                {t("lastRunLbl")}: {new Date(reconQ.data.lastRun.started_at * 1000).toLocaleString()} ·{" "}
                {reconQ.data.lastRun.accounts_checked} {t("accountsWord")} ·{" "}
                {reconQ.data.lastRun.mismatch_count} {t("mismatchesWord")}
                {reconQ.data.lastRun.ran_by ? "" : ` · ${t("nightlyWord")}`}
              </span>
            ) : (
              <span className="text-xs text-slate-500">{t("noReconYet")}</span>
            )}
          </div>
          {reconQ.data && reconQ.data.mismatches.length > 0 ? (
            <div className="space-y-1.5">
              {reconQ.data.mismatches.map((m: any) => (
                <div key={m.id} className="flex flex-wrap items-center gap-2 border border-red-500/20 rounded-lg px-3 py-2 bg-red-500/5 text-sm">
                  <Badge variant="secondary" className="bg-red-500/15 text-red-400 border-red-500/30">{m.kind}</Badge>
                  <button className="text-amber-300 underline decoration-dotted underline-offset-2" onClick={() => onFocusPlayer(m.user_id)}>
                    {m.name ?? m.email ?? `#${m.user_id}`}
                  </button>
                  <span className="font-mono text-xs text-slate-300">{m.currency}</span>
                  <span className="text-xs text-slate-400">
                    {t("expectedLbl")}: <span className="font-mono">{m.expected}</span> · {t("actualLbl")}: <span className="font-mono">{m.actual}</span>
                  </span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-slate-600">{t("firstSeenLbl")}: {new Date(m.first_seen_at * 1000).toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : reconQ.data ? (
            <p className="text-sm text-emerald-400">{t("reconClean")}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* Risk signals */}
      <Card className="bg-slate-900/80 border-slate-800">
        <CardHeader>
          <CardTitle className="text-base">{t("riskSignals")}</CardTitle>
          <CardDescription className="text-slate-400">{t("riskSignalsDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {signalsQ.isLoading || !signalsQ.data ? (
            <p className="text-sm text-slate-500">{t("loading")}</p>
          ) : (
            <div className="grid md:grid-cols-2 gap-5 text-sm">
              <div>
                <div className="text-xs uppercase text-slate-500 mb-2">{t("sigSharedAddress")}</div>
                {signalsQ.data.sharedAddresses.length === 0 ? <p className="text-xs text-slate-600">{t("noSignals")}</p> :
                  signalsQ.data.sharedAddresses.map((r: any) => (
                    <div key={r.address} className="border-b border-slate-800/60 py-1.5">
                      <div className="font-mono text-xs text-slate-300 break-all">{r.address}</div>
                      <div className="text-xs text-slate-400 flex flex-wrap gap-1 mt-0.5">{r.users.map(userChip)}</div>
                    </div>
                  ))}
              </div>
              <div>
                <div className="text-xs uppercase text-slate-500 mb-2">{t("sigSharedIp")}</div>
                {signalsQ.data.sharedIps.length === 0 ? <p className="text-xs text-slate-600">{t("noSignals")}</p> :
                  signalsQ.data.sharedIps.map((r: any) => (
                    <div key={r.ip} className="border-b border-slate-800/60 py-1.5">
                      <div className="font-mono text-xs text-slate-300">{r.ip}</div>
                      <div className="text-xs text-slate-400 flex flex-wrap gap-1 mt-0.5">{r.users.map(userChip)}</div>
                    </div>
                  ))}
              </div>
              <div>
                <div className="text-xs uppercase text-slate-500 mb-2">{t("sigSpinRate")}</div>
                {signalsQ.data.spinOutliers.length === 0 ? <p className="text-xs text-slate-600">{t("noSignals")}</p> :
                  signalsQ.data.spinOutliers.map((r: any) => (
                    <div key={r.userId} className="border-b border-slate-800/60 py-1.5 flex items-center gap-2">
                      <span className="text-slate-300">{r.users.map(userChip)}</span>
                      <span className="flex-1" />
                      <span className="font-mono text-xs">{r.spins24h} / 24h</span>
                    </div>
                  ))}
              </div>
              <div>
                <div className="text-xs uppercase text-slate-500 mb-2">{t("sigWinRate")}</div>
                {signalsQ.data.winOutliers.length === 0 ? <p className="text-xs text-slate-600">{t("noSignals")}</p> :
                  signalsQ.data.winOutliers.map((r: any) => (
                    <div key={r.userId} className="border-b border-slate-800/60 py-1.5 flex items-center gap-2">
                      <span className="text-slate-300">{r.users.map(userChip)}</span>
                      <span className="flex-1" />
                      <span className="font-mono text-xs text-red-300">RTP {r.rtpPct}%</span>
                      <span className="font-mono text-xs text-slate-500">{r.spins} spins</span>
                    </div>
                  ))}
              </div>
              <div>
                <div className="text-xs uppercase text-slate-500 mb-2">{t("sigDepositNoPlay")}</div>
                {signalsQ.data.depositNoPlay.length === 0 ? <p className="text-xs text-slate-600">{t("noSignals")}</p> :
                  signalsQ.data.depositNoPlay.map((r: any) => (
                    <div key={r.userId} className="border-b border-slate-800/60 py-1.5">
                      <span className="text-slate-300">{r.users.map(userChip)}</span>
                      <div className="font-mono text-xs text-slate-400 mt-0.5">
                        in ${r.depositsUsdt} · out ${r.withdrawalsUsdt} · wagered ${r.wageredUsdt}
                      </div>
                    </div>
                  ))}
              </div>
              <div>
                <div className="text-xs uppercase text-slate-500 mb-2">{t("sigLoginBursts")}</div>
                {signalsQ.data.failedLoginBursts.length === 0 ? <p className="text-xs text-slate-600">{t("noSignals")}</p> :
                  signalsQ.data.failedLoginBursts.map((r: any) => (
                    <div key={r.identifier} className="border-b border-slate-800/60 py-1.5 flex items-center gap-2">
                      <span className="font-mono text-xs text-slate-300">{r.identifier ?? "—"}</span>
                      <span className="flex-1" />
                      <span className="font-mono text-xs text-red-300">{r.failures}×</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Section F1: jackpot centre — pools, seeds, shares, history. */
function JackpotCentreCard({ enabled, canEdit }: { enabled: boolean; canEdit: boolean }) {
  const { t } = useLang();
  const centreQ = trpc.admin.getJackpotCentre.useQuery(undefined, { enabled, retry: false });
  const historyQ = trpc.admin.getJackpotHistory.useQuery({ days: 7 }, { enabled, retry: false });
  const [seeds, setSeeds] = useState<Record<string, string> | null>(null);
  const [shares, setShares] = useState<Record<string, string> | null>(null);
  const [adjust, setAdjust] = useState<Record<string, string>>({});

  useEffect(() => {
    if (centreQ.data && seeds === null) {
      const s: Record<string, string> = {};
      const sh: Record<string, string> = {};
      for (const tier of centreQ.data.tiers) {
        s[tier.tier] = String(tier.seed);
        sh[tier.tier] = String(tier.sharePerMille);
      }
      setSeeds(s);
      setShares(sh);
    }
  }, [centreQ.data, seeds]);

  const cfgM = trpc.admin.updateJackpotConfig.useMutation({
    onSuccess: async () => {
      toast.success(t("jackpotCfgSaved"));
      await centreQ.refetch();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const adjustM = trpc.admin.updateJackpot.useMutation({
    onSuccess: async () => {
      toast.success(t("jackpotUpdated"));
      setAdjust({});
      await centreQ.refetch();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const settingsM = trpc.admin.updateSettings.useMutation({
    onSuccess: async () => {
      await centreQ.refetch();
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (centreQ.isLoading || !centreQ.data || !seeds || !shares) {
    return (
      <Card className="bg-slate-900/80 border-slate-800">
        <CardContent className="pt-6 text-sm text-slate-500">{t("loading")}</CardContent>
      </Card>
    );
  }
  const centre = centreQ.data;

  // Merge per-tier hourly series into chart rows by hour bucket.
  const hourOf = (ts: number) => Math.floor(ts / 3600) * 3600;
  const rowMap = new Map<number, any>();
  for (const [tier, points] of Object.entries(historyQ.data ?? {})) {
    for (const pt of points as Array<{ ts: number; amount: number }>) {
      const h = hourOf(pt.ts);
      if (!rowMap.has(h)) rowMap.set(h, { ts: h });
      rowMap.get(h)[tier] = pt.amount;
    }
  }
  const chartRows = [...rowMap.values()].sort((a, b) => a.ts - b.ts);

  return (
    <div className="space-y-5">
      <Card className="bg-slate-900/80 border-slate-800">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Trophy className="h-4 w-4 text-amber-400" /> {t("jackpotCentre")}
          </CardTitle>
          <CardDescription className="text-slate-400">{t("jackpotCentreDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary" className="bg-slate-800 text-slate-300 border-slate-700">
              {t("totalPools")}: {centre.totalCurrent.toLocaleString()} USDT
            </Badge>
            <Badge variant="secondary" className="bg-slate-800 text-slate-300 border-slate-700">
              {t("totalContrib")}: {(centre.totalSharePerMille / 10).toFixed(1)}%
            </Badge>
            <label className="flex items-center gap-2 text-slate-400 ml-1">
              <input
                type="checkbox"
                checked={centre.lowPoolAlert}
                disabled={!canEdit}
                onChange={(e) => settingsM.mutate({ entries: { jackpot_low_pool_alert: e.target.checked } })}
                className="accent-amber-500"
              />
              {t("lowPoolAlertLbl")}
            </label>
          </div>

          {centre.tiers.map((pool: any) => (
            <div key={pool.tier} className="p-3 rounded-lg border border-slate-800 bg-slate-950/50 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold uppercase text-amber-400">{pool.tier} {t("jackpotWord")}</span>
                <span className="text-lg font-mono text-slate-100">{pool.current.toLocaleString()} USDT</span>
                {pool.belowSeed && centre.lowPoolAlert && (
                  <Badge variant="secondary" className="bg-red-500/15 text-red-400 border-red-500/30">{t("belowSeed")}</Badge>
                )}
                <span className="flex-1" />
                <span className="text-[11px] text-slate-500">
                  {t("hitsLbl")}: {pool.hitCount}
                  {pool.lastWonAt ? ` · ${t("lastWonLbl")}: ${new Date(pool.lastWonAt).toLocaleDateString()}` : ` · ${t("neverWon")}`}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
                <div>
                  <div className="text-[11px] text-slate-500 mb-1">{t("seedLbl")} (USDT)</div>
                  <Input
                    type="number"
                    min={0}
                    value={seeds[pool.tier]}
                    disabled={!canEdit}
                    onChange={(e) => setSeeds({ ...seeds, [pool.tier]: e.target.value })}
                    className="h-8 text-xs bg-slate-950 border-slate-700 font-mono"
                  />
                </div>
                <div>
                  <div className="text-[11px] text-slate-500 mb-1">{t("shareLbl")}</div>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={shares[pool.tier]}
                    disabled={!canEdit}
                    onChange={(e) => setShares({ ...shares, [pool.tier]: e.target.value })}
                    className="h-8 text-xs bg-slate-950 border-slate-700 font-mono"
                  />
                </div>
                <div>
                  <div className="text-[11px] text-slate-500 mb-1">{t("adjustLbl")}</div>
                  <Input
                    type="number"
                    min={0}
                    placeholder={t("amountPlaceholder")}
                    value={adjust[pool.tier] || ""}
                    disabled={!canEdit}
                    onChange={(e) => setAdjust({ ...adjust, [pool.tier]: e.target.value })}
                    className="h-8 text-xs bg-slate-950 border-slate-700 font-mono"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs border-slate-700"
                  disabled={!canEdit || !adjust[pool.tier] || adjustM.isPending}
                  onClick={() => {
                    const val = parseFloat(adjust[pool.tier]);
                    if (Number.isFinite(val) && val > 0) {
                      adjustM.mutate({ tier: pool.tier as "mini" | "major" | "mega", amount: val });
                    }
                  }}
                >
                  {t("setPoolBtn")}
                </Button>
              </div>
            </div>
          ))}

          {canEdit && (
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                className="h-8 text-xs bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold"
                disabled={cfgM.isPending}
                onClick={() =>
                  cfgM.mutate({
                    seeds: {
                      mini: parseFloat(seeds.mini) || 0,
                      major: parseFloat(seeds.major) || 0,
                      mega: parseFloat(seeds.mega) || 0,
                    },
                    shares: {
                      mini: parseInt(shares.mini, 10) || 0,
                      major: parseInt(shares.major, 10) || 0,
                      mega: parseInt(shares.mega, 10) || 0,
                    },
                  })
                }
              >
                {t("saveJackpotCfg")}
              </Button>
              <span className="text-[11px] text-slate-600">{t("jackpotCfgNote")}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-slate-900/80 border-slate-800">
        <CardHeader>
          <CardTitle className="text-base">{t("poolHistory")}</CardTitle>
        </CardHeader>
        <CardContent>
          {chartRows.length > 1 ? (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartRows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis
                    dataKey="ts"
                    tick={{ fill: "#64748b", fontSize: 10 }}
                    tickFormatter={(ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    minTickGap={60}
                  />
                  <YAxis tick={{ fill: "#64748b", fontSize: 10 }} width={48} domain={["auto", "auto"]} />
                  <Tooltip
                    contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#e2e8f0" }}
                    labelFormatter={(ts: any) => new Date(Number(ts) * 1000).toLocaleString()}
                  />
                  <Line type="monotone" dataKey="mega" name="Mega" stroke="#f59e0b" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="major" name="Major" stroke="#94a3b8" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="mini" name="Mini" stroke="#d97706" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-sm text-slate-500">{t("poolHistoryEmpty")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const LAB_SYM_KEYS = [
  "sym_zeus", "sym_thunderbolt", "sym_pegasus", "sym_temple", "sym_harp",
  "sym_amphora", "sym_helmet", "sym_shield", "sym_ace", "sym_king", "sym_queen",
] as const;

/** Section E: RTP Lab — draft -> certify -> publish -> rollback. */
function RtpLabCard({ enabled }: { enabled: boolean }) {
  const { t } = useLang();
  const labQ = trpc.admin.getMathLab.useQuery(undefined, { enabled, retry: false });
  const [bundle, setBundle] = useState<any>(null);
  const [reelText, setReelText] = useState<string[]>([]);
  const [reelError, setReelError] = useState("");
  const [cert, setCert] = useState<any>(null);
  const [certFor, setCertFor] = useState("");
  const [note, setNote] = useState("");
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState<number | null>(null);

  useEffect(() => {
    if (labQ.data && bundle === null) {
      const initial = structuredClone(labQ.data.draft ?? labQ.data.live);
      setBundle(initial);
      setReelText(initial.reels.map((r: number[]) => r.join(",")));
    }
  }, [labQ.data, bundle]);

  const edit = (next: any) => {
    setBundle(next);
    setCert(null);
    setCertFor("");
    setConfirmPublish(false);
  };

  const loadBundle = (b: any) => {
    const copy = structuredClone(b);
    setBundle(copy);
    setReelText(copy.reels.map((r: number[]) => r.join(",")));
    setCert(null);
    setCertFor("");
    setConfirmPublish(false);
    setReelError("");
  };

  const saveDraftM = trpc.admin.saveMathDraft.useMutation({
    onSuccess: async () => {
      toast.success(t("draftSaved"));
      await labQ.refetch();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const certifyM = trpc.admin.certifyMath.useMutation({
    onSuccess: (data: any) => {
      setCert(data);
      setCertFor(JSON.stringify(bundle));
    },
    onError: (e: any) => toast.error(e.message),
  });
  const publishM = trpc.admin.publishMath.useMutation({
    onSuccess: async () => {
      toast.success(t("publishedMsg"));
      setNote("");
      setConfirmPublish(false);
      await labQ.refetch();
      setBundle(null);
    },
    onError: (e: any) => toast.error(e.message),
  });
  const rollbackM = trpc.admin.rollbackMath.useMutation({
    onSuccess: async () => {
      toast.success(t("rolledBackMsg"));
      setConfirmRollback(null);
      await labQ.refetch();
      setBundle(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (!enabled) return null;
  if (labQ.isLoading || !bundle) {
    return (
      <Card className="bg-slate-900/80 border-slate-800">
        <CardContent className="pt-6 text-sm text-slate-500">{t("loading")}</CardContent>
      </Card>
    );
  }
  const data = labQ.data!;
  const certCurrent = cert && certFor === JSON.stringify(bundle);

  const setPay = (id: number, k: string, v: string) => {
    const next = structuredClone(bundle);
    next.paytable[String(id)][k] = v === "" ? 0 : Number(v);
    edit(next);
  };
  const setFs = (k: string, v: string) => {
    const next = structuredClone(bundle);
    next.freeSpins[k] = v === "" ? 0 : parseInt(v, 10) || 0;
    edit(next);
  };
  const setThunder = (field: string, v: string, isInt: boolean) => {
    const next = structuredClone(bundle);
    next.thunder[field] = v === "" ? 0 : isInt ? parseInt(v, 10) || 0 : Number(v);
    edit(next);
  };
  const commitReel = (idx: number) => {
    const parts = reelText[idx].split(/[,\s]+/).filter((x) => x !== "").map((x) => Number(x));
    if (parts.length < 10 || parts.length > 200 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 10)) {
      setReelError(t("reelInvalid"));
      return;
    }
    setReelError("");
    const next = structuredClone(bundle);
    next.reels[idx] = parts;
    edit(next);
  };

  return (
    <Card className="bg-slate-900/80 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4 text-amber-400" /> {t("rtpLab")}
        </CardTitle>
        <CardDescription className="text-slate-400">{t("rtpLabDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="bg-slate-800 text-slate-300 border-slate-700">
            {t("declaredRtp")}: {data.declaredRtp}%
          </Badge>
          <Badge variant="secondary" className="bg-slate-800 text-slate-300 border-slate-700">
            {t("publishBounds")}: {data.bounds.min}–{data.bounds.max}%
          </Badge>
          <Badge variant="secondary" className="bg-slate-800 text-slate-300 border-slate-700">
            {t("maxWinCapLbl")}: {data.maxWinX > 0 ? `${data.maxWinX}×` : t("capOff")}
          </Badge>
          <span className="flex-1" />
          <Button size="sm" variant="outline" className="h-7 text-xs border-slate-700" onClick={() => loadBundle(data.live)}>
            {t("loadLive")}
          </Button>
          {data.draft && (
            <Button size="sm" variant="outline" className="h-7 text-xs border-slate-700" onClick={() => loadBundle(data.draft)}>
              {t("loadDraft")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs border-slate-700"
            disabled={saveDraftM.isPending}
            onClick={() => saveDraftM.mutate({ bundle })}
          >
            {t("saveDraft")}
          </Button>
        </div>

        {/* Paytable editor */}
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">{t("labPaytable")}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1 pr-2">{t("symbolCol")}</th>
                  <th className="py-1 pr-2">×3</th>
                  <th className="py-1 pr-2">×4</th>
                  <th className="py-1">×5</th>
                </tr>
              </thead>
              <tbody>
                {LAB_SYM_KEYS.map((key, id) => (
                  <tr key={key} className="border-t border-slate-800/60">
                    <td className="py-1 pr-2 text-slate-300 whitespace-nowrap">{t(key as any)}</td>
                    {(["3", "4", "5"] as const).map((k) => (
                      <td key={k} className="py-1 pr-2">
                        <Input
                          type="number"
                          min={0}
                          value={bundle.paytable[String(id)][k]}
                          onChange={(e) => setPay(id, k, e.target.value)}
                          className="h-7 w-24 text-xs bg-slate-950 border-slate-700 font-mono"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Reels editor */}
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">{t("labReels")}</div>
          <div className="space-y-2">
            {bundle.reels.map((reel: number[], idx: number) => (
              <div key={idx} className="flex items-start gap-2">
                <span className="text-xs text-slate-400 pt-2 w-12 shrink-0">{t("reelN")} {idx + 1}</span>
                <Input
                  value={reelText[idx] ?? ""}
                  onChange={(e) => {
                    const next = [...reelText];
                    next[idx] = e.target.value;
                    setReelText(next);
                  }}
                  onBlur={() => commitReel(idx)}
                  className="text-[11px] bg-slate-950 border-slate-700 font-mono"
                />
                <span className="text-[11px] text-slate-500 pt-2 w-16 shrink-0">{reel.length} {t("stopsWord")}</span>
              </div>
            ))}
          </div>
          {reelError && <p className="text-xs text-red-400 mt-1">{reelError}</p>}
          <p className="text-[11px] text-slate-600 mt-1">{t("reelHint")}</p>
        </div>

        {/* Free spins + thunder */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {(["3", "4", "5"] as const).map((k) => (
            <div key={k}>
              <div className="text-[11px] text-slate-500 mb-1">{t("labFsAward")} ×{k}</div>
              <Input
                type="number"
                min={0}
                value={bundle.freeSpins[k]}
                onChange={(e) => setFs(k, e.target.value)}
                className="h-8 text-xs bg-slate-950 border-slate-700 font-mono"
              />
            </div>
          ))}
          <div>
            <div className="text-[11px] text-slate-500 mb-1">{t("labThunderDenom")}</div>
            <Input
              type="number"
              min={1}
              value={bundle.thunder.chanceDenominator}
              onChange={(e) => setThunder("chanceDenominator", e.target.value, true)}
              className="h-8 text-xs bg-slate-950 border-slate-700 font-mono"
            />
          </div>
          <div>
            <div className="text-[11px] text-slate-500 mb-1">{t("labThunderFloor")}</div>
            <Input
              type="number"
              min={0}
              step="0.5"
              value={bundle.thunder.floorX}
              onChange={(e) => setThunder("floorX", e.target.value, false)}
              className="h-8 text-xs bg-slate-950 border-slate-700 font-mono"
            />
          </div>
        </div>

        {/* Certify + results */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-8 text-xs bg-blue-600 hover:bg-blue-500 text-white font-semibold"
            disabled={certifyM.isPending}
            onClick={() => certifyM.mutate({ bundle })}
          >
            {certifyM.isPending ? t("certifying") : t("certifyBtn")}
          </Button>
          {cert && !certCurrent && <span className="text-xs text-amber-400">{t("certStale")}</span>}
          {certCurrent && (
            <Badge
              variant="secondary"
              className={cert.withinBounds ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-red-500/15 text-red-400 border-red-500/30"}
            >
              {cert.withinBounds ? t("withinBounds") : t("outOfBounds")}
            </Badge>
          )}
        </div>
        {certCurrent && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div><div className="text-[11px] text-slate-500">{t("certLines")}</div><div className="font-mono">{cert.linesPct}%</div></div>
              <div><div className="text-[11px] text-slate-500">{t("certScatter")}</div><div className="font-mono">{cert.scatterPct}%</div></div>
              <div><div className="text-[11px] text-slate-500">{t("certThunder")}</div><div className="font-mono">{cert.thunderPct}%</div></div>
              <div><div className="text-[11px] text-slate-500">{t("certJackpot")}</div><div className="font-mono">{cert.jackpotPct}%</div></div>
              <div><div className="text-[11px] text-slate-500">{t("fsPerSpinLbl")}</div><div className="font-mono">{cert.fsPerSpin}</div></div>
              <div><div className="text-[11px] text-slate-500">{t("hitRate")}</div><div className="font-mono">{cert.hitRatePct}%</div></div>
              <div><div className="text-[11px] text-slate-500">{t("maxWinObs")}</div><div className="font-mono">{cert.maxWinObservedX}×</div></div>
              <div><div className="text-[11px] text-slate-500">{t("certTotal")}</div><div className="font-mono text-lg text-amber-400">{cert.totalPct}%</div></div>
            </div>
            <p className="text-[11px] text-slate-600 mt-2">{t("certFormula")}</p>
          </div>
        )}

        {/* Publish */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-4">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("publishNotePh")}
            className="h-8 text-xs bg-slate-950 border-slate-700 max-w-xs"
          />
          {!confirmPublish ? (
            <Button
              size="sm"
              className="h-8 text-xs bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold"
              disabled={!certCurrent || !cert.withinBounds || publishM.isPending}
              onClick={() => setConfirmPublish(true)}
            >
              {t("publishMathBtn")}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                className="h-8 text-xs bg-red-600 hover:bg-red-500 text-white font-semibold"
                disabled={publishM.isPending}
                onClick={() => publishM.mutate({ bundle, note: note || undefined })}
              >
                {t("confirmPublish")}
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setConfirmPublish(false)}>
                {t("cancel")}
              </Button>
            </>
          )}
          <span className="text-[11px] text-slate-600">{t("publishWarn")}</span>
        </div>

        {/* Versions */}
        {data.versions.length > 0 && (
          <div className="border-t border-slate-800 pt-4">
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">{t("versionsTitle")}</div>
            <div className="space-y-1.5">
              {data.versions.map((v: any) => (
                <div key={v.id} className="flex flex-wrap items-center gap-2 text-xs border border-slate-800/70 rounded-lg px-3 py-2 bg-slate-950/40">
                  <span className="font-mono text-slate-300">#{v.id}</span>
                  <Badge variant="secondary" className="bg-slate-800 text-amber-300 border-slate-700 font-mono">{v.totalRtp}%</Badge>
                  <span className="text-slate-400 truncate max-w-[220px]">{v.note ?? "—"}</span>
                  <span className="text-slate-600">{new Date(v.createdAt * 1000).toLocaleString()}</span>
                  <span className="flex-1" />
                  {confirmRollback === v.id ? (
                    <>
                      <Button size="sm" className="h-6 text-[11px] bg-red-600 hover:bg-red-500 text-white" disabled={rollbackM.isPending} onClick={() => rollbackM.mutate({ versionId: v.id })}>
                        {t("confirmRollback")}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setConfirmRollback(null)}>{t("cancel")}</Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" className="h-6 text-[11px] border-slate-700" onClick={() => setConfirmRollback(v.id)}>
                      {t("rollbackBtn")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GameConfigCard({
  enabled,
  groups,
  showAudit = false,
  titleKey,
  canEdit = true,
}: {
  enabled: boolean;
  groups?: string[];
  showAudit?: boolean;
  titleKey?: string;
  // AP2: settings writes are super-admin only; plain admins browse.
  canEdit?: boolean;
}) {
  const { t, lang } = useLang();
  const utils = trpc.useUtils();
  const { data: settingsList, isLoading } = trpc.admin.getSettings.useQuery(
    undefined,
    { enabled, retry: false },
  );
  const { data: auditRows } = trpc.admin.getAuditLog.useQuery(
    { limit: 8 },
    { enabled: enabled && showAudit, retry: false },
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirtyKeys, setDirtyKeys] = useState<string[]>([]);

  const updateMutation = trpc.admin.updateSettings.useMutation({
    onSuccess: async () => {
      toast.success(t("configSaved"));
      setDirtyKeys([]);
      setDrafts({});
      await utils.admin.getSettings.invalidate();
      await utils.admin.getAuditLog.invalidate();
      await utils.game.getConfig.invalidate();
    },
    onError: (err) => toast.error(`${t("configSaveFailed")}: ${err.message}`),
  });

  if (!enabled) return null;

  const visibleGroups = groups ?? ALL_GROUPS;
  const mathDirty = (settingsList ?? []).some(
    (s) => s.group === "math" && dirtyKeys.includes(s.key),
  );

  const draftFor = (s: any): string => {
    if (drafts[s.key] !== undefined) return drafts[s.key];
    if (s.type === "json") return JSON.stringify(s.value, null, 1);
    if (s.type === "boolean") return s.value ? "true" : "false";
    return String(s.value ?? "");
  };

  const setDraft = (key: string, value: string) => {
    setDrafts((d) => ({ ...d, [key]: value }));
    setDirtyKeys((k) => (k.includes(key) ? k : [...k, key]));
  };

  const handleSave = () => {
    if (!settingsList) return;
    const entries: Record<string, unknown> = {};
    for (const key of dirtyKeys) {
      const def = settingsList.find((s) => s.key === key);
      if (!def) continue;
      const raw = drafts[key];
      try {
        if (def.type === "number") {
          const n = Number(raw);
          if (!Number.isFinite(n)) throw new Error("number");
          entries[key] = n;
        } else if (def.type === "boolean") {
          entries[key] = raw === "true";
        } else if (def.type === "json") {
          entries[key] = JSON.parse(raw);
        } else {
          entries[key] = raw;
        }
      } catch {
        toast.error(`${t("configInvalidJson")} ${key}`);
        return;
      }
    }
    updateMutation.mutate({ entries });
  };

  return (
    <Card className="bg-slate-900/80 border-slate-800">
      <CardHeader>
        <CardTitle className="text-amber-400">{t((titleKey ?? "gameConfig") as any)}</CardTitle>
        <CardDescription className="text-slate-400">{t("gameConfigDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {visibleGroups.length > 0 && (
          isLoading || !settingsList ? (
            <div className="text-slate-400 text-sm">…</div>
          ) : (
            visibleGroups.map((group) => {
              const items = settingsList.filter((s) => s.group === group);
              if (!items.length) return null;
              return (
                <div key={group}>
                  <h3 className="text-sm font-semibold text-slate-300 mb-3">
                    {t(`cfgGroup_${group}` as any)}
                  </h3>
                  <div className="grid gap-4 md:grid-cols-2">
                    {items.map((s) => (
                      <label key={s.key} className="block">
                        <span className="block text-xs text-slate-400 mb-1">
                          {lang === "bn" ? s.labelBn : s.labelEn}
                          <span className="text-slate-600"> · {s.key}</span>
                        </span>
                        {s.type === "boolean" ? (
                          <input
                            type="checkbox"
                            disabled={!canEdit}
                            className="h-4 w-4 accent-amber-500 disabled:opacity-50"
                            checked={draftFor(s) === "true"}
                            onChange={(e) =>
                              setDraft(s.key, e.target.checked ? "true" : "false")
                            }
                          />
                        ) : s.type === "json" ? (
                          <textarea
                            disabled={!canEdit}
                            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200 min-h-[72px] disabled:opacity-50"
                            value={draftFor(s)}
                            onChange={(e) => setDraft(s.key, e.target.value)}
                          />
                        ) : (
                          <Input
                            disabled={!canEdit}
                            className="bg-slate-950 border-slate-700 text-slate-200 disabled:opacity-50"
                            value={draftFor(s)}
                            inputMode={s.type === "string" ? "text" : "decimal"}
                            onChange={(e) => setDraft(s.key, e.target.value)}
                          />
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })
          )
        )}

        {mathDirty && (
          <div className="rounded border border-amber-500/50 bg-amber-500/10 text-amber-300 text-xs px-3 py-2">
            {t("rtpWarning")}
          </div>
        )}

        {visibleGroups.length > 0 && (
          canEdit ? (
            <div className="flex items-center gap-3">
              <Button
                className="bg-amber-500 hover:bg-amber-400 text-black font-semibold"
                disabled={!dirtyKeys.length || updateMutation.isPending}
                onClick={handleSave}
              >
                {t("saveChanges")}
                {dirtyKeys.length ? ` (${dirtyKeys.length})` : ""}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-slate-500">{t("superOnlyNote")}</p>
          )
        )}

        {showAudit && !!auditRows?.length && (
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-2">
              {t("recentChanges")}
            </h3>
            <ul className="space-y-1 text-xs text-slate-400">
              {auditRows.map((row: any) => (
                <li key={row.id} className="flex gap-2 flex-wrap">
                  <span className="text-slate-500">
                    {new Date(row.createdAt).toLocaleString()}
                  </span>
                  <span className="text-slate-200">{row.action}</span>
                  <span className="text-slate-500 truncate max-w-[420px]">
                    {typeof row.details === "object"
                      ? JSON.stringify(row.details)
                      : String(row.details ?? "")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// AP3: Access & sessions card — admin accounts with 2FA state and
// last sign-in, the recent auth event trail, and force sign-out
// (super admin only; bumps the account's session epoch server-side).
function AccessCard({ enabled, isSuper }: { enabled: boolean; isSuper: boolean }) {
  const { t } = useLang();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.admin.getAccessOverview.useQuery(undefined, {
    enabled,
    retry: false,
  });
  const forceSignOut = trpc.admin.forceSignOut.useMutation({
    onSuccess: async () => {
      toast.success(t("forceSignOutDone"));
      await utils.admin.getAccessOverview.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (!enabled) return null;

  return (
    <Card className="bg-slate-900/80 border-slate-800">
      <CardHeader>
        <CardTitle className="text-amber-400">{t("accessTitle")}</CardTitle>
        <CardDescription className="text-slate-400">{t("accessDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading || !data ? (
          <div className="text-slate-400 text-sm">…</div>
        ) : (
          <>
            <div className="space-y-2">
              {data.admins.map((a: any) => (
                <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{a.name ?? "—"} <span className="text-slate-500">· {a.email ?? ""}</span></div>
                    <div className="text-xs text-slate-500">
                      {t("lastSignIn")}: {a.lastSignInAt ? new Date(a.lastSignInAt).toLocaleString() : "—"}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <Badge className={a.totpEnabled ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" : "bg-red-500/20 text-red-300 border-red-500/30"}>
                      2FA {a.totpEnabled ? t("on") : t("off")}
                    </Badge>
                    {isSuper && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-slate-700 text-slate-300 hover:bg-slate-800"
                        disabled={forceSignOut.isPending}
                        onClick={() => forceSignOut.mutate({ userId: a.id })}
                      >
                        {t("forceSignOut")}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-2">{t("accessEvents")}</h3>
              {!data.events.length ? (
                <p className="text-xs text-slate-500">{t("queueEmpty")}</p>
              ) : (
                <ul className="space-y-1 text-xs text-slate-400">
                  {data.events.map((e: any) => (
                    <li key={e.id} className="flex gap-2 flex-wrap">
                      <span className="text-slate-500">{new Date(e.createdAt).toLocaleString()}</span>
                      <span className="text-slate-200">{e.action}</span>
                      <span>{e.userEmail ?? e.userName ?? (typeof e.details === "object" ? (e.details as any)?.identifier ?? "" : "")}</span>
                      <span className="text-slate-600">{e.ipAddress ?? ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-slate-600">{t("sessionNote")}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// P0.2: admin sections (sidebar). Sections with no content yet in the
// approved programme (Risk = Section G, Promotions = Section H) render
// an honest placeholder instead of pretending to work.
const SECTIONS = [
  { id: "dashboard", icon: LayoutDashboard, labelKey: "navDashboard" },
  { id: "players", icon: Users, labelKey: "navPlayers" },
  { id: "payments", icon: CreditCard, labelKey: "navPayments" },
  { id: "engine", icon: Cog, labelKey: "navEngine" },
  { id: "jackpots", icon: Trophy, labelKey: "navJackpots" },
  { id: "site", icon: Globe, labelKey: "navSite" },
  { id: "risk", icon: ShieldAlert, labelKey: "navRisk" },
  { id: "promotions", icon: Gift, labelKey: "navPromotions" },
  { id: "system", icon: ServerCog, labelKey: "navSystem" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function sectionFromHash(): SectionId {
  const h = window.location.hash.replace("#", "");
  return (SECTIONS.some((s) => s.id === h) ? h : "dashboard") as SectionId;
}

export default function Admin() {
  const { t } = useLang();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // Client-side gate: the page is only usable by authenticated admins.
  // (The server independently enforces the admin role on every admin query.)
  const { isAuthenticated, isLoading: authLoading, user, refresh } = useAuth({
    redirectOnUnauthenticated: true,
    redirectPath: "/login",
  });
  const role = (user as any)?.role as string | undefined;
  const isAdmin = role === "admin" || role === "super_admin";
  const isSuper = role === "super_admin";

  // AP1: a setup-scoped admin session must complete 2FA enrollment
  // first. AP1b: confirm with a fresh /me fetch before redirecting —
  // the cache can still hold the previous account right after a
  // login switch.
  useEffect(() => {
    if ((user as any)?.authScope !== "setup") return;
    let cancelled = false;
    refresh().then((res) => {
      if (!cancelled && (res.data as any)?.authScope === "setup") {
        navigate("/security");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user, navigate, refresh]);

  const [section, setSection] = useState<SectionId>(() => sectionFromHash());
  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const goSection = (id: SectionId) => {
    window.location.hash = id;
    setSection(id);
  };

  // Section B: dashboard analytics state + queries.
  const [analyticsRange, setAnalyticsRange] = useState<"today" | "7d" | "30d" | "all" | "custom">("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const { data: analytics } = trpc.admin.getAnalytics.useQuery(
    {
      range: analyticsRange,
      from: analyticsRange === "custom" && customFrom ? customFrom : undefined,
      to: analyticsRange === "custom" && customTo ? customTo : undefined,
    },
    { enabled: isAuthenticated && isAdmin && section === "dashboard", retry: false },
  );
  const { data: cashflow } = trpc.admin.getCashflowSeries.useQuery(
    { days: 30 },
    { enabled: isAuthenticated && isAdmin && section === "dashboard", retry: false },
  );
  const { data: topPlayers } = trpc.admin.getTopPlayers.useQuery(
    { range: analyticsRange === "7d" ? "7d" : analyticsRange === "all" ? "all" : "30d" },
    { enabled: isAuthenticated && isAdmin && section === "dashboard", retry: false },
  );
  const { data: moneyPos } = trpc.admin.getMoneyPosition.useQuery(undefined, {
    enabled: isAuthenticated && isAdmin && section === "dashboard",
    retry: false,
  });

  const { data: stats, isLoading: statsLoading } = trpc.admin.getStats.useQuery(undefined, {
    enabled: isAuthenticated && isAdmin,
    retry: false,
  });
  // Section C: player list v2 + 360 detail state.
  const [playerSearch, setPlayerSearch] = useState("");
  const [playerStatus, setPlayerStatus] = useState("");
  const [playerSort, setPlayerSort] = useState<"newest" | "balance" | "activity">("newest");
  const [playerOffset, setPlayerOffset] = useState(0);
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const { data: playerList, isLoading: usersLoading } = trpc.admin.listPlayers.useQuery(
    {
      search: playerSearch || undefined,
      status: (playerStatus || undefined) as any,
      sort: playerSort,
      limit: 25,
      offset: playerOffset,
    },
    { enabled: isAuthenticated && isAdmin && section === "players", retry: false },
  );
  const { data: playerDetail } = trpc.admin.getPlayerDetail.useQuery(
    { userId: selectedPlayerId ?? 0 },
    { enabled: isAuthenticated && isAdmin && selectedPlayerId !== null, retry: false },
  );
  const [adjCurrency, setAdjCurrency] = useState("USDT");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjReason, setAdjReason] = useState("");
  const [freezeReason, setFreezeReason] = useState("");
  const [noteText, setNoteText] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const invalidatePlayers = async () => {
    await utils.admin.listPlayers.invalidate();
    await utils.admin.getPlayerDetail.invalidate();
    await utils.admin.getStats.invalidate();
  };
  const adjustMutation = trpc.admin.adjustPlayerBalance.useMutation({
    onSuccess: async (data: any) => {
      toast.success(`${t("adjustDone")} — ${t("newBalance")}: ${data.balanceAfter} ${adjCurrency}`);
      setAdjAmount("");
      setAdjReason("");
      await invalidatePlayers();
    },
    onError: (err) => toast.error(err.message),
  });
  const freezeMutation = trpc.admin.setPlayerFrozen.useMutation({
    onSuccess: async (_d, vars: any) => {
      toast.success(vars.frozen ? t("playerFrozen") : t("playerUnfrozen"));
      setFreezeReason("");
      await invalidatePlayers();
    },
    onError: (err) => toast.error(err.message),
  });
  const noteMutation = trpc.admin.addPlayerNote.useMutation({
    onSuccess: async () => {
      toast.success(t("noteAdded"));
      setNoteText("");
      await utils.admin.getPlayerDetail.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const tagsMutation = trpc.admin.setPlayerTags.useMutation({
    onSuccess: async () => {
      toast.success(t("tagsSaved"));
      await invalidatePlayers();
    },
    onError: (err) => toast.error(err.message),
  });
  const resetPwMutation = trpc.admin.resetPlayerPassword.useMutation({
    onSuccess: async (data: any) => {
      setTempPassword(data.tempPassword);
      toast.success(t("pwResetDone"));
    },
    onError: (err) => toast.error(err.message),
  });
  const { data: riskSummary } = trpc.admin.getRiskSummary.useQuery(undefined, {
    enabled: isAuthenticated && isAdmin,
    retry: false,
  });
  const { data: pendingTxs, isLoading: txsLoading } = trpc.admin.listPendingTransactions.useQuery(undefined, {
    enabled: isAuthenticated && isAdmin,
    refetchInterval: 15000,
  });

  // D1: deposit-reject inline form + history filters
  const [rejectFor, setRejectFor] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  // D3/D4: per-row 2FA codes, hold form, mark-paid form, snapshot
  const [totpByTx, setTotpByTx] = useState<Record<number, string>>({});
  const [holdFor, setHoldFor] = useState<number | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const [markPaidFor, setMarkPaidFor] = useState<number | null>(null);
  const [payoutRef, setPayoutRef] = useState("");
  const [snapshotFor, setSnapshotFor] = useState<{ userId: number; email: string } | null>(null);
  const { data: snapshot } = trpc.admin.getPlayerMoneySummary.useQuery(
    { userId: snapshotFor?.userId ?? 0 },
    { enabled: isAuthenticated && isAdmin && snapshotFor !== null, retry: false },
  );
  const [histStatus, setHistStatus] = useState("");
  const [histType, setHistType] = useState("");
  const [histSearch, setHistSearch] = useState("");
  const { data: txHistory } = trpc.admin.listTransactions.useQuery(
    {
      status: (histStatus || undefined) as any,
      type: (histType || undefined) as any,
      search: histSearch || undefined,
      limit: 50,
      offset: 0,
    },
    { enabled: isAuthenticated && isAdmin && section === "payments", retry: false },
  );

  const updateRoleMutation = trpc.admin.updateUserRole.useMutation({
    onSuccess: async () => {
      toast.success(t("roleUpdated"));
      await utils.admin.getUsers.invalidate();
    },
    onError: (err) => {
      toast.error(`${t("roleUpdateFailed")}: ${err.message}`);
    },
  });

  const invalidateTx = async () => {
    await utils.admin.listPendingTransactions.invalidate();
    await utils.admin.getStats.invalidate();
  };

  const approveDepositMutation = trpc.admin.approveDeposit.useMutation({
    onSuccess: async () => {
      toast.success(t("depositApproved"));
      await invalidateTx();
    },
    onError: (err) => toast.error(`${t("approveFailed")}: ${err.message}`),
  });

  const approveWithdrawMutation = trpc.admin.approveWithdraw.useMutation({
    onSuccess: async (data: any) => {
      toast.success(data?.stage === "awaiting-second" ? t("firstApprovalRecorded") : t("withdrawApproved"));
      await invalidateTx();
      await utils.admin.listTransactions.invalidate();
    },
    onError: (err) => toast.error(`${t("approveFailed")}: ${err.message}`),
  });

  const releaseHoldMutation = trpc.admin.releaseHold.useMutation({
    onSuccess: async () => {
      toast.success(t("holdReleased"));
      setSnapshotFor(null);
      await invalidateTx();
      await utils.admin.listTransactions.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const addHoldMutation = trpc.admin.addHold.useMutation({
    onSuccess: async () => {
      toast.success(t("holdPlaced"));
      setHoldFor(null);
      setHoldReason("");
      await invalidateTx();
      await utils.admin.listTransactions.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const markPaidMutation = trpc.admin.markWithdrawalPaid.useMutation({
    onSuccess: async () => {
      toast.success(t("markedPaid"));
      setMarkPaidFor(null);
      setPayoutRef("");
      await utils.admin.listTransactions.invalidate();
      await invalidateTx();
    },
    onError: (err) => toast.error(err.message),
  });

  const rejectDepositMutation = trpc.admin.rejectDeposit.useMutation({
    onSuccess: async () => {
      toast.success(t("depositRejected"));
      setRejectFor(null);
      setRejectReason("");
      await invalidateTx();
      await utils.admin.listTransactions.invalidate();
    },
    onError: (err) => toast.error(`${t("rejectFailed")}: ${err.message}`),
  });

  const rejectWithdrawMutation = trpc.admin.rejectWithdraw.useMutation({
    onSuccess: async () => {
      toast.success(t("withdrawRejected"));
      await invalidateTx();
    },
    onError: (err) => toast.error(`${t("rejectFailed")}: ${err.message}`),
  });

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <p className="text-slate-400">{t("checkingAccess")}</p>
      </div>
    );
  }

  if (!isAuthenticated || !isAdmin) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <Card className="w-full max-w-md border-slate-800">
          <CardHeader className="text-center">
            <CardTitle className="flex items-center justify-center gap-2">
              <ShieldCheck className="h-5 w-5 text-red-400" /> {t("accessDenied")}
            </CardTitle>
            <CardDescription>
              {t("accessDeniedDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full bg-[#D4AF37] text-black hover:bg-[#F4D03F]"
              onClick={() => navigate("/login")}
            >
              {t("goToLogin")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }


  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="icon"
              onClick={() => navigate("/")}
              className="border-slate-700 bg-slate-900 hover:bg-slate-800"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
              {t("adminTitle")}
            </h1>
          </div>
          <p className="text-slate-400 mt-1 text-sm">
            {t("adminSubtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-400 py-1 px-3">
            <ShieldCheck className="h-3.5 w-3.5 mr-1.5" /> {t("ownerMode")}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={() => utils.invalidate()}
            className="border-slate-700 bg-slate-900"
          >
            <RefreshCw className="h-4 w-4 mr-2" /> {t("refresh")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 mt-6">
        {/* Sidebar nav — horizontal scroll row on small screens */}
        <nav className="lg:w-52 shrink-0">
          <div className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0 lg:sticky lg:top-6">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => goSection(s.id)}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                    active
                      ? "bg-amber-500/15 text-amber-300 font-semibold"
                      : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {t(s.labelKey as any)}
                  {s.id === "payments" && !!pendingTxs?.length && (
                    <span className="ml-auto rounded-full bg-red-500/20 text-red-300 text-[11px] px-1.5 py-0.5 font-mono">
                      {pendingTxs.length}
                    </span>
                  )}
                  {s.id === "risk" && !!riskSummary && riskSummary.openAlerts + riskSummary.openMismatches > 0 && (
                    <span className="ml-auto rounded-full bg-red-500/20 text-red-300 text-[11px] px-1.5 py-0.5 font-mono">
                      {riskSummary.openAlerts + riskSummary.openMismatches}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </nav>

        <main className="flex-1 min-w-0 space-y-8">
          {section === "dashboard" && (
            <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              <Card className="bg-slate-900/80 border-slate-800">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-slate-400">{t("totalPlayers")}</CardTitle>
                  <Users className="h-4 w-4 text-amber-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{statsLoading ? "..." : stats?.totalUsers}</div>
                  <p className="text-xs text-slate-500 mt-1">{t("registeredAccounts")}</p>
                </CardContent>
              </Card>

              <Card className="bg-slate-900/80 border-slate-800">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-slate-400">{t("totalWagered")}</CardTitle>
                  <DollarSign className="h-4 w-4 text-emerald-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">${statsLoading ? "..." : stats?.totalWagered.toLocaleString()}</div>
                  <p className="text-xs text-slate-500 mt-1">{t("fromSpins", { n: stats?.totalSpins ?? 0 })}</p>
                </CardContent>
              </Card>

              <Card className="bg-slate-900/80 border-slate-800">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-slate-400">{t("houseProfit")}</CardTitle>
                  <Trophy className="h-4 w-4 text-amber-400" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-emerald-400">${statsLoading ? "..." : stats?.houseProfit.toLocaleString()}</div>
                  <p className="text-xs text-slate-500 mt-1">{t("netRevenue")}</p>
                </CardContent>
              </Card>

              <Card className="bg-slate-900/80 border-slate-800">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-slate-400">{t("houseRtp")}</CardTitle>
                  <Percent className="h-4 w-4 text-blue-400" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-blue-400">{statsLoading ? "..." : stats?.houseRtp}</div>
                  <p className="text-xs text-slate-500 mt-1">{t("targetRtp")}</p>
                </CardContent>
              </Card>
            </div>

            {/* Section B: range analytics */}
            <div className="flex flex-wrap items-center gap-2">
              {(["today", "7d", "30d", "all", "custom"] as const).map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={analyticsRange === r ? "default" : "outline"}
                  className={analyticsRange === r ? "bg-amber-500 text-slate-950 hover:bg-amber-400 h-7 text-xs" : "border-slate-700 text-slate-300 h-7 text-xs"}
                  onClick={() => setAnalyticsRange(r)}
                >
                  {r === "today" ? t("rangeToday") : r === "7d" ? t("range7d") : r === "30d" ? t("range30d") : r === "all" ? t("rangeAll") : t("rangeCustom")}
                </Button>
              ))}
              {analyticsRange === "custom" && (
                <>
                  <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="bg-slate-950 border-slate-700 text-slate-200 h-7 text-xs w-36" />
                  <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="bg-slate-950 border-slate-700 text-slate-200 h-7 text-xs w-36" />
                </>
              )}
            </div>

            {analytics && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                {[
                  { label: t("signupsLabel"), value: String(analytics.signups) },
                  { label: t("depositsLabel"), value: `$${analytics.depositsUsdt.toLocaleString()}` },
                  { label: t("withdrawalsLabel"), value: `$${analytics.withdrawalsUsdt.toLocaleString()}` },
                  { label: t("netCashflow"), value: `$${analytics.netCashflowUsdt.toLocaleString()}` },
                  { label: t("wageredRange"), value: `$${analytics.wageredUsdt.toLocaleString()}` },
                  { label: t("ggrLabel"), value: `$${analytics.ggrUsdt.toLocaleString()}` },
                ].map((c) => (
                  <Card key={c.label} className="bg-slate-900/80 border-slate-800">
                    <CardContent className="pt-4">
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">{c.label}</div>
                      <div className="text-xl font-bold mt-1">{c.value}</div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <Card className="bg-slate-900/80 border-slate-800">
                <CardHeader>
                  <CardTitle className="text-base">{t("rtpMonitor")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {analytics ? (
                    <>
                      <div className="flex items-baseline gap-6">
                        <div>
                          <div className="text-[11px] uppercase text-slate-500">{t("actualRtp")}</div>
                          <div className="text-3xl font-bold text-blue-400">
                            {analytics.actualRtp !== null ? `${analytics.actualRtp.toFixed(2)}%` : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase text-slate-500">{t("theoreticalRtp")}</div>
                          <div className="text-3xl font-bold text-slate-300">{analytics.theoreticalRtp.toFixed(1)}%</div>
                        </div>
                        {analytics.actualRtp !== null && (
                          <Badge
                            variant="secondary"
                            className={
                              Math.abs(analytics.actualRtp - analytics.theoreticalRtp) <= 2
                                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                                : "bg-amber-500/15 text-amber-400 border-amber-500/30"
                            }
                          >
                            Δ {(analytics.actualRtp - analytics.theoreticalRtp).toFixed(2)}%
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">{t("rtpDriftNote")}</p>
                    </>
                  ) : (
                    <p className="text-sm text-slate-500">{t("loading")}</p>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-slate-900/80 border-slate-800">
                <CardHeader>
                  <CardTitle className="text-base">{t("moneyPosition")}</CardTitle>
                </CardHeader>
                <CardContent>
                  {moneyPos ? (
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div><div className="text-slate-500 text-xs">{t("liabilities")}</div><div className="font-mono text-lg">${moneyPos.liabilitiesUsdt.toLocaleString()}</div></div>
                      <div><div className="text-slate-500 text-xs">{t("lockedLabel")}</div><div className="font-mono text-lg">${moneyPos.lockedUsdt.toLocaleString()}</div></div>
                      <div><div className="text-slate-500 text-xs">{t("poolsLabel")}</div><div className="font-mono text-lg">${moneyPos.poolsUsdt.toLocaleString()}</div></div>
                      <div><div className="text-slate-500 text-xs">{t("pendingOut")}</div><div className="font-mono text-lg">${moneyPos.pendingWithdrawalsUsdt.toLocaleString()} <span className="text-xs text-slate-500">({moneyPos.pendingWithdrawalsCount})</span></div></div>
                      <div className="col-span-2 flex flex-wrap gap-2">
                        {moneyPos.pools.map((pl: any) => (
                          <span key={pl.tier} className="text-xs font-mono bg-slate-800/80 border border-slate-700 rounded px-2 py-1 uppercase">
                            {pl.tier}: {pl.currentAmount} USDT
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">{t("loading")}</p>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card className="bg-slate-900/80 border-slate-800">
              <CardHeader>
                <CardTitle className="text-base">{t("cashflowTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                {cashflow ? (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={cashflow} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} minTickGap={40} />
                        <YAxis tick={{ fill: "#64748b", fontSize: 10 }} width={48} />
                        <Tooltip
                          contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, fontSize: 12 }}
                          labelStyle={{ color: "#e2e8f0" }}
                        />
                        <Bar dataKey="deposits" name={t("depositsLabel")} fill="#10b981" radius={[3, 3, 0, 0]} />
                        <Bar dataKey="withdrawals" name={t("withdrawalsLabel")} fill="#f59e0b" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">{t("loading")}</p>
                )}
              </CardContent>
            </Card>

            <Card className="bg-slate-900/80 border-slate-800">
              <CardHeader>
                <CardTitle className="text-base">{t("topPlayersTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                {topPlayers ? (
                  <div className="grid md:grid-cols-3 gap-5 text-sm">
                    <div>
                      <div className="text-xs uppercase text-slate-500 mb-2">{t("topWagered")}</div>
                      {topPlayers.byWagered.length === 0 ? <p className="text-slate-500 text-xs">{t("noResults")}</p> : topPlayers.byWagered.map((pl: any, i: number) => (
                        <div key={pl.userId} className="flex justify-between border-b border-slate-800/60 py-1">
                          <span className="text-slate-300 truncate mr-2">{i + 1}. {pl.name ?? pl.email}</span>
                          <span className="font-mono">${pl.wagered.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div className="text-xs uppercase text-slate-500 mb-2">{t("topNetLoss")}</div>
                      {topPlayers.byNetLoss.length === 0 ? <p className="text-slate-500 text-xs">{t("noResults")}</p> : topPlayers.byNetLoss.map((pl: any, i: number) => (
                        <div key={pl.userId} className="flex justify-between border-b border-slate-800/60 py-1">
                          <span className="text-slate-300 truncate mr-2">{i + 1}. {pl.name ?? pl.email}</span>
                          <span className="font-mono">${pl.net.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div className="text-xs uppercase text-slate-500 mb-2">{t("biggestWin")}</div>
                      {topPlayers.biggestWin ? (
                        <div className="space-y-1">
                          <div className="font-mono text-2xl text-amber-400">{topPlayers.biggestWin.win.toLocaleString()} {topPlayers.biggestWin.currency}</div>
                          <div className="text-slate-400 text-xs">{topPlayers.biggestWin.name ?? topPlayers.biggestWin.email}</div>
                          <div className="text-slate-500 text-xs">{t("betAmount")}: {topPlayers.biggestWin.bet} {topPlayers.biggestWin.currency}</div>
                        </div>
                      ) : (
                        <p className="text-slate-500 text-xs">{t("noResults")}</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">{t("loading")}</p>
                )}
              </CardContent>
            </Card>
            </div>
          )}

          {section === "players" && (
            <>
            <Card className="bg-slate-900/80 border-slate-800">
              <CardHeader>
                <CardTitle>{t("userManagement")}</CardTitle>
                <CardDescription className="text-slate-400">{t("userManagementDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={playerSearch}
                    onChange={(e) => { setPlayerSearch(e.target.value); setPlayerOffset(0); }}
                    placeholder={t("searchPlayersPh")}
                    className="bg-slate-950 border-slate-700 text-slate-200 h-8 text-xs max-w-xs"
                  />
                  <select
                    value={playerStatus}
                    onChange={(e) => { setPlayerStatus(e.target.value); setPlayerOffset(0); }}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200"
                  >
                    <option value="">{t("allPlayers")}</option>
                    <option value="active">{t("statusActive")}</option>
                    <option value="frozen">{t("frozenBadge")}</option>
                  </select>
                  <select
                    value={playerSort}
                    onChange={(e) => setPlayerSort(e.target.value as any)}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200"
                  >
                    <option value="newest">{t("sortNewest")}</option>
                    <option value="balance">{t("sortBalance")}</option>
                    <option value="activity">{t("sortActivity")}</option>
                  </select>
                  <span className="text-xs text-slate-500 self-center">
                    {t("totalPlayers")}: {playerList?.total ?? 0}
                  </span>
                  <div className="flex gap-1 ml-auto">
                    <Button size="sm" variant="outline" className="h-7 text-xs border-slate-700 text-slate-300" disabled={playerOffset === 0} onClick={() => setPlayerOffset(Math.max(0, playerOffset - 25))}>{t("prevPage")}</Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs border-slate-700 text-slate-300" disabled={!playerList || playerOffset + 25 >= playerList.total} onClick={() => setPlayerOffset(playerOffset + 25)}>{t("nextPage")}</Button>
                  </div>
                </div>
                {usersLoading ? (
                  <p className="text-sm text-slate-500 py-4">{t("loading")}</p>
                ) : !playerList || playerList.rows.length === 0 ? (
                  <p className="text-sm text-slate-500 py-2">{t("noResults")}</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-slate-800 hover:bg-transparent">
                        <TableHead className="text-slate-400">{t("playerName")}</TableHead>
                        <TableHead className="text-slate-400">{t("role")}</TableHead>
                        <TableHead className="text-slate-400">{t("balanceCol")}</TableHead>
                        <TableHead className="text-slate-400">{t("lastSpinCol")}</TableHead>
                        <TableHead className="text-right text-slate-400">{t("actions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {playerList.rows.map((u: any) => (
                        <TableRow key={u.id} className="border-slate-800/60">
                          <TableCell>
                            <div className="font-medium flex items-center gap-2">
                              {u.name ?? `User ${u.id}`}
                              {!u.isActive && (
                                <Badge variant="secondary" className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px]">{t("frozenBadge")}</Badge>
                              )}
                            </div>
                            <div className="text-xs text-slate-500">{u.email ?? ""}{u.phone ? ` · ${u.phone}` : ""}</div>
                            {u.tags.length > 0 && (
                              <div className="flex gap-1 mt-1">
                                {u.tags.map((tag: string) => (
                                  <span key={tag} className="text-[10px] bg-sky-500/15 text-sky-300 border border-sky-500/30 rounded px-1.5 py-0.5">{tag}</span>
                                ))}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={u.role === "user" ? "secondary" : "default"}
                              className={
                                u.role === "super_admin"
                                  ? "bg-red-500/20 text-red-300 border-red-500/30"
                                  : u.role === "admin"
                                    ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                                    : "bg-slate-800 text-slate-300"
                              }
                            >
                              {String(u.role).replace("_", " ").toUpperCase()}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-sm">${Number(u.balanceUsdt).toFixed(2)}</TableCell>
                          <TableCell className="text-xs text-slate-500">
                            {u.lastSpinAt ? new Date(u.lastSpinAt).toLocaleString() : t("neverLabel")}
                          </TableCell>
                          <TableCell className="text-right space-x-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs border-slate-600 text-slate-200 hover:bg-slate-800"
                              onClick={() => { setSelectedPlayerId(selectedPlayerId === u.id ? null : u.id); setTempPassword(null); setTagsText(""); }}
                            >
                              {t("detailsBtn")}
                            </Button>
                            {isSuper && (
                              <select
                                value={u.role}
                                disabled={updateRoleMutation.isPending}
                                onChange={(e) =>
                                  updateRoleMutation.mutate({
                                    userId: u.id,
                                    role: e.target.value as "user" | "admin" | "super_admin",
                                  })
                                }
                                className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                              >
                                <option value="user">user</option>
                                <option value="admin">admin</option>
                                <option value="super_admin">super_admin</option>
                              </select>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {selectedPlayerId !== null && playerDetail && (
              <Card className="bg-slate-900/80 border-sky-900/60">
                <CardHeader>
                  <CardTitle className="flex items-center gap-3 flex-wrap">
                    <span>{playerDetail.profile.name ?? `User ${playerDetail.profile.id}`}</span>
                    {!playerDetail.profile.isActive && (
                      <Badge variant="secondary" className="bg-red-500/15 text-red-400 border-red-500/30">{t("frozenBadge")}</Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="text-slate-400">
                    {playerDetail.profile.email ?? ""} · {t("memberSince")}: {new Date(playerDetail.profile.createdAt).toLocaleDateString()} · {t("lastSignIn")}: {playerDetail.profile.lastSignInAt ? new Date(playerDetail.profile.lastSignInAt).toLocaleString() : t("neverLabel")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
                    <div><div className="text-slate-500 text-xs">{t("lifetimeDeposits")}</div><div className="font-mono">${Number(playerDetail.stats.depositedUsdt).toFixed(2)}</div></div>
                    <div><div className="text-slate-500 text-xs">{t("lifetimeWithdrawals")}</div><div className="font-mono">${Number(playerDetail.stats.withdrawnUsdt).toFixed(2)}</div></div>
                    <div><div className="text-slate-500 text-xs">{t("totalWagered")}</div><div className="font-mono">${Number(playerDetail.stats.wageredUsdt).toFixed(2)}</div></div>
                    <div><div className="text-slate-500 text-xs">{t("wonLabel")}</div><div className="font-mono">${Number(playerDetail.stats.wonUsdt).toFixed(2)}</div></div>
                    <div><div className="text-slate-500 text-xs">{t("spinsLabel")}</div><div className="font-mono">{playerDetail.stats.spinsCount}</div></div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {playerDetail.balances.map((b: any) => (
                      <span key={b.currency} className="text-xs font-mono bg-slate-800/80 border border-slate-700 rounded px-2 py-1">
                        {b.currency}: {b.available}{b.locked !== "0" ? ` (+${b.locked} locked)` : ""}{b.bonus && b.bonus !== "0" ? ` · ${t("bonusBalance")} ${b.bonus}` : ""}
                      </span>
                    ))}
                  </div>
                  {(playerDetail.bonuses ?? []).length > 0 && (
                    <div className="text-xs text-slate-400 bg-slate-950/60 border border-slate-800 rounded p-3">
                      <span className="text-slate-300 font-medium">{t("activeBonuses")}: </span>
                      {(playerDetail.bonuses as any[]).map((g) => `${g.kind} · ${g.currency} ${g.remaining}/${g.amount} · ${t("bonusWagered")} ${g.wagered}`).join("  |  ")}
                    </div>
                  )}
                  {playerDetail.rg && (
                    <div className="text-xs text-slate-400 bg-slate-950/60 border border-slate-800 rounded p-3">
                      <span className="text-slate-300 font-medium">{t("rgState")}: </span>
                      {t("rgDepositLimit")}: {playerDetail.rg.limits.depositLimitDaily ?? t("noLimitSet")} · {t("rgLossLimit")}: {playerDetail.rg.limits.lossLimitDaily ?? t("noLimitSet")} · {t("rgSessionLimit")}: {playerDetail.rg.limits.sessionLimitMinutes ?? t("noLimitSet")} · {t("selfExcludedUntil")}: {playerDetail.rg.limits.selfExcludedUntil > 0 ? new Date(playerDetail.rg.limits.selfExcludedUntil * 1000).toLocaleString() : t("noLimitSet")}
                    </div>
                  )}

                  {playerDetail.profile.role === "user" && (
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="rounded-lg border border-slate-800 p-3 space-y-2">
                        <div className="text-sm font-medium text-slate-200">{t("adjustTitle")}</div>
                        <div className="flex gap-2">
                          <select value={adjCurrency} onChange={(e) => setAdjCurrency(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200">
                            <option value="USDT">USDT</option>
                            <option value="BDT">BDT</option>
                          </select>
                          <Input value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} placeholder={t("adjustAmountPh")} className="bg-slate-950 border-slate-700 text-slate-200 h-8 text-xs" />
                        </div>
                        <Input value={adjReason} onChange={(e) => setAdjReason(e.target.value)} placeholder={t("reasonPh")} className="bg-slate-950 border-slate-700 text-slate-200 h-8 text-xs" />
                        <Button size="sm" className="bg-sky-600 hover:bg-sky-500 text-white" disabled={adjustMutation.isPending || !/^-?\d+(\.\d{1,8})?$/.test(adjAmount) || adjReason.trim().length < 3} onClick={() => adjustMutation.mutate({ userId: playerDetail.profile.id, currency: adjCurrency as any, amount: adjAmount, reason: adjReason.trim() })}>
                          {t("adjustBtn")}
                        </Button>
                      </div>
                      <div className="rounded-lg border border-slate-800 p-3 space-y-2">
                        <div className="text-sm font-medium text-slate-200">{playerDetail.profile.isActive ? t("freezeTitle") : t("unfreezeTitle")}</div>
                        <Input value={freezeReason} onChange={(e) => setFreezeReason(e.target.value)} placeholder={t("reasonPh")} className="bg-slate-950 border-slate-700 text-slate-200 h-8 text-xs" />
                        <Button size="sm" className={playerDetail.profile.isActive ? "bg-red-600 hover:bg-red-500 text-white" : "bg-emerald-600 hover:bg-emerald-500 text-white"} disabled={freezeMutation.isPending || freezeReason.trim().length < 3} onClick={() => freezeMutation.mutate({ userId: playerDetail.profile.id, frozen: playerDetail.profile.isActive, reason: freezeReason.trim() })}>
                          {playerDetail.profile.isActive ? t("freezeBtn") : t("unfreezeBtn")}
                        </Button>
                        {isSuper && (
                          <div className="pt-2 border-t border-slate-800 space-y-2">
                            <Button size="sm" variant="outline" className="border-slate-600 text-slate-200" disabled={resetPwMutation.isPending} onClick={() => resetPwMutation.mutate({ userId: playerDetail.profile.id })}>
                              {t("resetPwBtn")}
                            </Button>
                            {tempPassword && (
                              <div className="text-xs bg-amber-500/10 border border-amber-500/30 rounded p-2 text-amber-200">
                                {t("tempPwNote")} <span className="font-mono font-bold select-all">{tempPassword}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="rounded-lg border border-slate-800 p-3 space-y-2">
                      <div className="text-sm font-medium text-slate-200">{t("tagsTitle")}</div>
                      <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder={playerDetail.profile.tags.join(", ") || t("tagsPh")} className="bg-slate-950 border-slate-700 text-slate-200 h-8 text-xs" />
                      <Button size="sm" variant="outline" className="border-slate-600 text-slate-200" disabled={tagsMutation.isPending} onClick={() => tagsMutation.mutate({ userId: playerDetail.profile.id, tags: tagsText.split(",").map((x) => x.trim()).filter(Boolean) })}>
                        {t("saveTags")}
                      </Button>
                    </div>
                    <div className="rounded-lg border border-slate-800 p-3 space-y-2">
                      <div className="text-sm font-medium text-slate-200">{t("notesTitle")}</div>
                      <div className="space-y-1.5 max-h-36 overflow-y-auto">
                        {playerDetail.notes.length === 0 ? (
                          <p className="text-xs text-slate-500">{t("noResults")}</p>
                        ) : playerDetail.notes.map((n: any) => (
                          <div key={n.id} className="text-xs bg-slate-950/60 border border-slate-800 rounded p-2">
                            <div className="text-slate-200">{n.note}</div>
                            <div className="text-slate-500 mt-0.5">{n.adminEmail ?? ""} · {new Date(n.createdAt).toLocaleString()}</div>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <Input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder={t("notePh")} className="bg-slate-950 border-slate-700 text-slate-200 h-8 text-xs" />
                        <Button size="sm" className="bg-sky-600 hover:bg-sky-500 text-white shrink-0" disabled={noteMutation.isPending || noteText.trim().length === 0} onClick={() => noteMutation.mutate({ userId: playerDetail.profile.id, note: noteText.trim() })}>
                          {t("addNote")}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-4 text-xs">
                    <div>
                      <div className="text-sm font-medium text-slate-200 mb-2">{t("recentTxs")}</div>
                      {playerDetail.recentTxs.length === 0 ? <p className="text-slate-500">{t("noResults")}</p> : playerDetail.recentTxs.map((tx: any) => (
                        <div key={tx.id} className="flex justify-between border-b border-slate-800/60 py-1">
                          <span className="text-slate-400">#{tx.id} {tx.type}</span>
                          <span className="font-mono">{tx.amount} {tx.currency}</span>
                          <span className="text-slate-500">{tx.status}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-slate-200 mb-2">{t("recentSpins")}</div>
                      {playerDetail.recentSpins.length === 0 ? <p className="text-slate-500">{t("noResults")}</p> : playerDetail.recentSpins.map((sp: any) => (
                        <div key={sp.id} className="flex justify-between border-b border-slate-800/60 py-1">
                          <span className="text-slate-400">#{sp.id}{sp.isFreeSpin ? " (free)" : ""}</span>
                          <span className="font-mono">-{sp.betAmount} / +{sp.winAmount} {sp.currency}</span>
                          <span className="text-slate-500">{new Date(sp.createdAt).toLocaleDateString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {playerDetail.auditTrail.length > 0 && (
                    <div className="text-xs">
                      <div className="text-sm font-medium text-slate-200 mb-2">{t("auditTrail")}</div>
                      {playerDetail.auditTrail.map((a: any) => (
                        <div key={a.id} className="flex gap-3 border-b border-slate-800/60 py-1">
                          <span className="text-slate-500 shrink-0">{new Date(a.createdAt).toLocaleString()}</span>
                          <span className="text-slate-300 font-mono">{a.action}</span>
                          <span className="text-slate-500 truncate">{typeof a.details === "string" ? a.details : JSON.stringify(a.details)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            </>
          )}

          {section === "payments" && (
            <>
              <Card className="bg-slate-900/80 border-slate-800">
                <CardHeader>
                  <CardTitle>{t("pendingTransactions")}</CardTitle>
                  <CardDescription className="text-slate-400">
                    {t("pendingDesc")}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {txsLoading ? (
                    <p className="text-sm text-slate-500 py-4">{t("queueLoading")}</p>
                  ) : !pendingTxs || pendingTxs.length === 0 ? (
                    <p className="text-sm text-slate-500 py-4">{t("queueEmpty")}</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="border-slate-800 hover:bg-transparent">
                          <TableHead className="text-slate-400">ID</TableHead>
                          <TableHead className="text-slate-400">{t("playerName")}</TableHead>
                          <TableHead className="text-slate-400">{t("type")}</TableHead>
                          <TableHead className="text-slate-400">{t("amountPlaceholder")}</TableHead>
                          <TableHead className="text-slate-400">{t("address")}</TableHead>
                          <TableHead className="text-right text-slate-400">{t("actions")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingTxs.map((tx) => (
                          <TableRow key={tx.id} className="border-slate-800/60">
                            <TableCell className="font-mono text-xs">#{tx.id}</TableCell>
                            <TableCell>
                              <div className="font-medium">{tx.userName ?? `User ${tx.userId}`}</div>
                              <div className="text-xs text-slate-500">{tx.userEmail ?? tx.userPhone ?? "—"}</div>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="secondary"
                                className={
                                  tx.type === "deposit"
                                    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                                    : "bg-orange-500/15 text-orange-400 border-orange-500/30"
                                }
                              >
                                {tx.type.toUpperCase()}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {tx.amount} {tx.currency}
                              {(tx as any).usdtEq != null && (
                                <div className="text-[11px] text-slate-500 font-sans">≈ ${Number((tx as any).usdtEq).toFixed(2)}</div>
                              )}
                              {(tx as any).status === "confirming" && (
                                <div className="mt-1"><Badge variant="secondary" className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px]">{t("awaitingSecond")}</Badge></div>
                              )}
                              {(tx as any).holdReason && (
                                <div className="mt-1"><Badge variant="secondary" className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px]">{t("onHold")}</Badge></div>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-slate-500 max-w-[180px]">
                              <div className="truncate">{tx.type === "deposit" && tx.txHash ? tx.txHash : tx.toAddress ?? "—"}</div>
                              {(tx as any).holdReason && (
                                <div className="text-red-400/90 font-sans text-[11px] whitespace-normal">{String((tx as any).holdReason)}</div>
                              )}
                            </TableCell>
                            <TableCell className="text-right space-x-2">
                              {tx.type === "deposit" ? (
                                <>
                                  <Button
                                    size="sm"
                                    className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                                    disabled={approveDepositMutation.isPending}
                                    onClick={() => approveDepositMutation.mutate({ txId: tx.id })}
                                  >
                                    {t("approveDeposit")}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs border-red-500/40 text-red-400 hover:bg-red-500/10"
                                    onClick={() => { setRejectFor(rejectFor === tx.id ? null : tx.id); setRejectReason(""); }}
                                  >
                                    {t("reject")}
                                  </Button>
                                </>
                              ) : (
                                <div className="flex flex-wrap items-center justify-end gap-1.5">
                                  {/* 2FA code is due only when THIS click executes the payout:
                                      confirming stage, or no dual stage stands in front of it. */}
                                  {(tx as any).requiresTotp && !((tx as any).status === "pending" && (tx as any).requiresDual) && (
                                    <Input
                                      value={totpByTx[tx.id] ?? ""}
                                      onChange={(e) => setTotpByTx((prev) => ({ ...prev, [tx.id]: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
                                      placeholder={t("totpCodePh")}
                                      inputMode="numeric"
                                      className="h-7 w-24 text-xs bg-slate-950 border-slate-700 text-slate-100"
                                    />
                                  )}
                                  <Button
                                    size="sm"
                                    className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                                    disabled={approveWithdrawMutation.isPending || !!(tx as any).holdReason}
                                    onClick={() => approveWithdrawMutation.mutate({ txId: tx.id, totpCode: totpByTx[tx.id] || undefined })}
                                  >
                                    {(tx as any).status === "confirming" ? t("approveSecond") : (tx as any).requiresDual ? t("approveFirst") : t("approvePayout")}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs border-red-500/40 text-red-400 hover:bg-red-500/10"
                                    disabled={rejectWithdrawMutation.isPending}
                                    onClick={() => rejectWithdrawMutation.mutate({ txId: tx.id })}
                                  >
                                    {t("reject")}
                                  </Button>
                                  {(tx as any).holdReason ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                                      disabled={releaseHoldMutation.isPending}
                                      onClick={() => releaseHoldMutation.mutate({ txId: tx.id })}
                                    >
                                      {t("releaseHold")}
                                    </Button>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs border-slate-600 text-slate-300 hover:bg-slate-800"
                                      onClick={() => { setHoldFor(holdFor === tx.id ? null : tx.id); setHoldReason(""); }}
                                    >
                                      {t("placeHold")}
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 text-xs text-slate-400 hover:text-slate-200"
                                    onClick={() => setSnapshotFor(snapshotFor?.userId === tx.userId ? null : { userId: tx.userId, email: tx.userEmail ?? "" })}
                                  >
                                    {t("detailsBtn")}
                                  </Button>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
              {rejectFor !== null && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
                  <div className="text-sm text-red-300 font-medium">
                    {t("rejectingDeposit")} #{rejectFor}
                  </div>
                  <Input
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder={t("rejectReasonPh")}
                    className="bg-slate-950 border-slate-700 text-slate-200"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="bg-red-600 hover:bg-red-500 text-white"
                      disabled={rejectDepositMutation.isPending || rejectReason.trim().length < 3}
                      onClick={() => rejectDepositMutation.mutate({ txId: rejectFor, reason: rejectReason.trim() })}
                    >
                      {t("confirmReject")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-slate-700 text-slate-300"
                      onClick={() => setRejectFor(null)}
                    >
                      {t("cancel")}
                    </Button>
                  </div>
                </div>
              )}
              {holdFor !== null && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
                  <div className="text-sm text-amber-300 font-medium">{t("placingHold")} #{holdFor}</div>
                  <Input
                    value={holdReason}
                    onChange={(e) => setHoldReason(e.target.value)}
                    placeholder={t("holdReasonPh")}
                    className="bg-slate-950 border-slate-700 text-slate-200"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="bg-amber-600 hover:bg-amber-500 text-white"
                      disabled={addHoldMutation.isPending || holdReason.trim().length < 3}
                      onClick={() => addHoldMutation.mutate({ txId: holdFor, reason: holdReason.trim() })}
                    >
                      {t("placeHold")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-slate-700 text-slate-300"
                      onClick={() => setHoldFor(null)}
                    >
                      {t("cancel")}
                    </Button>
                  </div>
                </div>
              )}
              {snapshotFor !== null && (
                <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-4 space-y-2">
                  <div className="text-sm font-medium text-slate-200">
                    {t("snapshotTitle")} — {snapshotFor.email}
                  </div>
                  {!snapshot ? (
                    <p className="text-sm text-slate-500">{t("loading")}</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div><div className="text-slate-500 text-xs">{t("lifetimeDeposits")}</div><div className="font-mono">${Number(snapshot.depositedUsdt).toFixed(2)}</div></div>
                        <div><div className="text-slate-500 text-xs">{t("lifetimeWithdrawals")}</div><div className="font-mono">${Number(snapshot.withdrawnUsdt).toFixed(2)}</div></div>
                        <div><div className="text-slate-500 text-xs">{t("totalWagered")}</div><div className="font-mono">${Number(snapshot.wageredUsdt).toFixed(2)}</div></div>
                        <div><div className="text-slate-500 text-xs">{t("pendingCountLabel")}</div><div className="font-mono">{snapshot.pendingCount}</div></div>
                      </div>
                      <div className="flex flex-wrap gap-2 pt-1">
                        {snapshot.balances.map((b: any) => (
                          <span key={b.currency} className="text-xs font-mono bg-slate-800/80 border border-slate-700 rounded px-2 py-1">
                            {b.currency}: {b.available} {b.locked !== "0" ? `(+${b.locked} locked)` : ""}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              <Card className="bg-slate-900/80 border-slate-800">
                <CardHeader>
                  <CardTitle>{t("historyTitle")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <select
                      value={histStatus}
                      onChange={(e) => setHistStatus(e.target.value)}
                      className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200"
                    >
                      <option value="">{t("allStatuses")}</option>
                      <option value="pending">pending</option>
                      <option value="confirming">confirming</option>
                      <option value="confirmed">confirmed</option>
                      <option value="failed">failed</option>
                      <option value="cancelled">cancelled</option>
                    </select>
                    <select
                      value={histType}
                      onChange={(e) => setHistType(e.target.value)}
                      className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200"
                    >
                      <option value="">{t("allTypes")}</option>
                      <option value="deposit">deposit</option>
                      <option value="withdrawal">withdrawal</option>
                    </select>
                    <Input
                      value={histSearch}
                      onChange={(e) => setHistSearch(e.target.value)}
                      placeholder={t("searchTxPh")}
                      className="bg-slate-950 border-slate-700 text-slate-200 h-8 text-xs max-w-xs"
                    />
                  </div>
                  {!txHistory || txHistory.length === 0 ? (
                    <p className="text-sm text-slate-500 py-2">{t("noResults")}</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="border-slate-800 hover:bg-transparent">
                          <TableHead className="text-slate-400">ID</TableHead>
                          <TableHead className="text-slate-400">{t("playerName")}</TableHead>
                          <TableHead className="text-slate-400">{t("type")}</TableHead>
                          <TableHead className="text-slate-400">{t("amountPlaceholder")}</TableHead>
                          <TableHead className="text-slate-400">{t("statusCol")}</TableHead>
                          <TableHead className="text-slate-400">{t("noteCol")}</TableHead>
                          <TableHead className="text-slate-400">{t("dateCol")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {txHistory.map((tx: any) => (
                          <TableRow key={tx.id} className="border-slate-800/60">
                            <TableCell className="font-mono text-xs">#{tx.id}</TableCell>
                            <TableCell>
                              <div className="font-medium">{tx.userName ?? `User ${tx.userId}`}</div>
                              <div className="text-xs text-slate-500">{tx.userEmail ?? ""}</div>
                            </TableCell>
                            <TableCell className="text-xs">{tx.type.toUpperCase()}</TableCell>
                            <TableCell className="font-mono text-sm">{tx.amount} {tx.currency}</TableCell>
                            <TableCell>
                              <Badge
                                variant="secondary"
                                className={
                                  tx.status === "confirmed"
                                    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                                    : tx.status === "pending" || tx.status === "confirming"
                                      ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                                      : "bg-red-500/15 text-red-400 border-red-500/30"
                                }
                              >
                                {tx.status.toUpperCase()}
                              </Badge>
                              {tx.type === "withdrawal" && tx.status === "confirmed" && (
                                <span className="ml-2 text-[11px] text-slate-400">
                                  {tx.paidAt ? `${t("paidLabel")} · ${tx.payoutRef ?? ""}` : t("unpaidLabel")}
                                </span>
                              )}
                              {tx.type === "withdrawal" && tx.status === "confirmed" && !tx.paidAt && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="ml-2 h-6 text-[11px] border-slate-600 text-slate-300 hover:bg-slate-800"
                                  onClick={() => { setMarkPaidFor(markPaidFor === tx.id ? null : tx.id); setPayoutRef(""); }}
                                >
                                  {t("markPaid")}
                                </Button>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-slate-400 max-w-[200px] truncate">
                              {tx.reviewNote ?? tx.holdReason ?? (tx.type === "deposit" ? tx.txHash : tx.toAddress) ?? "—"}
                            </TableCell>
                            <TableCell className="text-xs text-slate-500">
                              {new Date(tx.createdAt).toLocaleString()}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
              {markPaidFor !== null && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
                  <div className="text-sm text-emerald-300 font-medium">{t("markingPaid")} #{markPaidFor}</div>
                  <Input
                    value={payoutRef}
                    onChange={(e) => setPayoutRef(e.target.value)}
                    placeholder={t("payoutRefPh")}
                    className="bg-slate-950 border-slate-700 text-slate-200"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="bg-emerald-600 hover:bg-emerald-500 text-white"
                      disabled={markPaidMutation.isPending || payoutRef.trim().length < 3}
                      onClick={() => markPaidMutation.mutate({ txId: markPaidFor, payoutRef: payoutRef.trim() })}
                    >
                      {t("markPaid")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-slate-700 text-slate-300"
                      onClick={() => setMarkPaidFor(null)}
                    >
                      {t("cancel")}
                    </Button>
                  </div>
                </div>
              )}
              <GameConfigCard enabled={isAuthenticated && isAdmin} groups={["currencies"]} titleKey="cfgGroup_currencies" canEdit={isSuper} />
            </>
          )}

          {section === "engine" && (
            <div className="space-y-5">
              <GameConfigCard enabled={isAuthenticated && isAdmin} groups={["bets", "features", "presentation", "math"]} titleKey="navEngine" canEdit={isSuper} />
              {isSuper && <RtpLabCard enabled={isAuthenticated && isAdmin} />}
            </div>
          )}

          {section === "jackpots" && (
            <JackpotCentreCard enabled={isAuthenticated && isAdmin} canEdit={isSuper} />
          )}

          {section === "site" && (
            <GameConfigCard enabled={isAuthenticated && isAdmin} groups={["site", "presentation"]} titleKey="cfgGroup_site" canEdit={isSuper} />
          )}

          {section === "risk" && (
            <RiskSection
              enabled={isAuthenticated && isAdmin}
              onFocusPlayer={(id) => { setSelectedPlayerId(id); goSection("players"); }}
            />
          )}
          {section === "promotions" && <PromotionsSection enabled={isAuthenticated && isAdmin} />}

          {section === "system" && (
            <>
              <GameConfigCard enabled={isAuthenticated && isAdmin} groups={["security"]} titleKey="cfgGroup_security" canEdit={isSuper} />
              <Card className="bg-slate-900/80 border-slate-800">
                <CardHeader>
                  <CardTitle className="text-amber-400">{t("totpCardTitle")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <TotpSetup />
                </CardContent>
              </Card>
              <AccessCard enabled={isAuthenticated && isAdmin} isSuper={isSuper} />
              <HealthCard enabled={isAuthenticated && isAdmin} />
              <ExportsCard enabled={isAuthenticated && isAdmin} />
              <AlertChannelsCard enabled={isAuthenticated && isAdmin} canEdit={isSuper} />
              <GameConfigCard enabled={isAuthenticated && isAdmin} groups={[]} showAudit titleKey="recentChanges" />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
