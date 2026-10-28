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
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
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
  const { data: jackpotPools, refetch: refetchJackpots } = trpc.jackpot.getPools.useQuery();
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

  const [jackpotAmount, setJackpotAmount] = useState<Record<string, string>>({
    mini: "",
    major: "",
    mega: "",
  });

  const updateRoleMutation = trpc.admin.updateUserRole.useMutation({
    onSuccess: async () => {
      toast.success(t("roleUpdated"));
      await utils.admin.getUsers.invalidate();
    },
    onError: (err) => {
      toast.error(`${t("roleUpdateFailed")}: ${err.message}`);
    },
  });

  const updateJackpotMutation = trpc.admin.updateJackpot.useMutation({
    onSuccess: async () => {
      toast.success(t("jackpotUpdated"));
      await refetchJackpots();
    },
    onError: (err) => {
      toast.error(`${t("jackpotUpdateFailed")}: ${err.message}`);
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

  const placeholder = (
    <Card className="bg-slate-900/80 border-slate-800">
      <CardContent className="py-10 text-center text-sm text-slate-400">
        {t("sectionComingSoon")}
      </CardContent>
    </Card>
  );

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
                        {b.currency}: {b.available}{b.locked !== "0" ? ` (+${b.locked} locked)` : ""}
                      </span>
                    ))}
                  </div>
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
            <GameConfigCard enabled={isAuthenticated && isAdmin} groups={["bets", "features", "presentation", "math"]} titleKey="navEngine" canEdit={isSuper} />
          )}

          {section === "jackpots" && (
            <Card className="bg-slate-900/80 border-slate-800">
              <CardHeader>
                <CardTitle>{t("jackpotControls")}</CardTitle>
                <CardDescription className="text-slate-400">{t("jackpotControlsDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {jackpotPools?.map((pool) => (
                  <div key={pool.tier} className="space-y-2 p-3 rounded-lg border border-slate-800 bg-slate-950/50">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold uppercase text-amber-400">{pool.tier} {t("jackpotWord")}</span>
                      <span className="text-sm font-mono text-slate-300">{pool.amount} {(pool as any).currency ?? "USDT"}</span>
                    </div>
                    {isSuper && (<div className="flex gap-2">
                      <Input
                        type="number"
                        placeholder={t("amountPlaceholder")}
                        value={jackpotAmount[pool.tier] || ""}
                        onChange={(e) => setJackpotAmount({ ...jackpotAmount, [pool.tier]: e.target.value })}
                        className="h-8 text-xs bg-slate-900 border-slate-800"
                      />
                      <Button
                        size="sm"
                        className="h-8 text-xs bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold"
                        onClick={() => {
                          const val = parseFloat(jackpotAmount[pool.tier]);
                          if (!val || val <= 0) return toast.error(t("errEnterPositive"));
                          updateJackpotMutation.mutate({ tier: pool.tier as "mini" | "major" | "mega", amount: val });
                        }}
                      >
                        {t("save")}
                      </Button>
                    </div>)}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {section === "site" && (
            <GameConfigCard enabled={isAuthenticated && isAdmin} groups={["site"]} titleKey="cfgGroup_site" canEdit={isSuper} />
          )}

          {section === "risk" && placeholder}
          {section === "promotions" && placeholder}

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
              <GameConfigCard enabled={isAuthenticated && isAdmin} groups={[]} showAudit titleKey="recentChanges" />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
