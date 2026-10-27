import { trpc } from "@/providers/trpc";
import { useLang } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/useAuth";
import { Users, DollarSign, Trophy, Percent, ShieldCheck, ArrowLeft, RefreshCw } from "lucide-react";
import { toast } from "sonner";

// B3: Admin Game Config — every admin-controllable setting (B1/B2) edited
// in one card, grouped, with EN/BN labels from the API definitions, typed
// inputs (toggle / number / money / text / JSON), an RTP warning when math
// keys are dirty, and the recent-change audit trail underneath.
function GameConfigCard({ enabled }: { enabled: boolean }) {
  const { t, lang } = useLang();
  const utils = trpc.useUtils();
  const { data: settingsList, isLoading } = trpc.admin.getSettings.useQuery(
    undefined,
    { enabled, retry: false },
  );
  const { data: auditRows } = trpc.admin.getAuditLog.useQuery(
    { limit: 8 },
    { enabled, retry: false },
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

  const groups = ["site", "bets", "features", "currencies", "presentation", "math"];
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
    <Card className="bg-slate-900/80 border-slate-800 mt-6">
      <CardHeader>
        <CardTitle className="text-amber-400">{t("gameConfig")}</CardTitle>
        <CardDescription className="text-slate-400">{t("gameConfigDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading || !settingsList ? (
          <div className="text-slate-400 text-sm">…</div>
        ) : (
          groups.map((group) => {
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
                          className="h-4 w-4 accent-amber-500"
                          checked={draftFor(s) === "true"}
                          onChange={(e) =>
                            setDraft(s.key, e.target.checked ? "true" : "false")
                          }
                        />
                      ) : s.type === "json" ? (
                        <textarea
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200 min-h-[72px]"
                          value={draftFor(s)}
                          onChange={(e) => setDraft(s.key, e.target.value)}
                        />
                      ) : (
                        <Input
                          className="bg-slate-950 border-slate-700 text-slate-200"
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
        )}

        {mathDirty && (
          <div className="rounded border border-amber-500/50 bg-amber-500/10 text-amber-300 text-xs px-3 py-2">
            {t("rtpWarning")}
          </div>
        )}

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

        {!!auditRows?.length && (
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

export default function Admin() {
  const { t } = useLang();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // Client-side gate: the page is only usable by authenticated admins.
  // (The server independently enforces the admin role on every admin query.)
  const { isAuthenticated, isLoading: authLoading, user } = useAuth({
    redirectOnUnauthenticated: true,
    redirectPath: "/login",
  });
  const isAdmin = user?.role === "admin";

  const { data: stats, isLoading: statsLoading } = trpc.admin.getStats.useQuery(undefined, {
    enabled: isAuthenticated && isAdmin,
    retry: false,
  });
  const { data: users, isLoading: usersLoading } = trpc.admin.getUsers.useQuery(undefined, {
    enabled: isAuthenticated && isAdmin,
    retry: false,
  });
  const { data: jackpotPools, refetch: refetchJackpots } = trpc.jackpot.getPools.useQuery();
  const { data: pendingTxs, isLoading: txsLoading } = trpc.admin.listPendingTransactions.useQuery(undefined, {
    enabled: isAuthenticated && isAdmin,
    refetchInterval: 15000,
  });

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
      toast.error(`{t("roleUpdateFailed")}: ${err.message}`);
    },
  });

  const updateJackpotMutation = trpc.admin.updateJackpot.useMutation({
    onSuccess: async () => {
      toast.success(t("jackpotUpdated"));
      await refetchJackpots();
    },
    onError: (err) => {
      toast.error(`{t("jackpotUpdateFailed")}: ${err.message}`);
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
    onError: (err) => toast.error(`{t("approveFailed")}: ${err.message}`),
  });

  const approveWithdrawMutation = trpc.admin.approveWithdraw.useMutation({
    onSuccess: async () => {
      toast.success(t("withdrawApproved"));
      await invalidateTx();
    },
    onError: (err) => toast.error(`{t("approveFailed")}: ${err.message}`),
  });

  const rejectWithdrawMutation = trpc.admin.rejectWithdraw.useMutation({
    onSuccess: async () => {
      toast.success(t("withdrawRejected"));
      await invalidateTx();
    },
    onError: (err) => toast.error(`{t("rejectFailed")}: ${err.message}`),
  });

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <p className="text-slate-400">Checking access...</p>
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
              Go to Login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10 space-y-8">
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

      {/* Analytics KPI Cards */}
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

      {/* Main Grid: User Management & Jackpot Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* User Management (2 Columns) */}
        <Card className="lg:col-span-2 bg-slate-900/80 border-slate-800">
          <CardHeader>
            <CardTitle>{t("userManagement")}</CardTitle>
            <CardDescription className="text-slate-400">{t("userManagementDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {usersLoading ? (
              <p className="text-sm text-slate-500 py-4">{t("loading")}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-800 hover:bg-transparent">
                    <TableHead className="text-slate-400">{t("userId")}</TableHead>
                    <TableHead className="text-slate-400">{t("playerName")}</TableHead>
                    <TableHead className="text-slate-400">{t("role")}</TableHead>
                    <TableHead className="text-right text-slate-400">{t("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users?.map((u) => (
                    <TableRow key={u.id} className="border-slate-800/60">
                      <TableCell className="font-mono text-xs">{u.unionId}</TableCell>
                      <TableCell className="font-medium">{u.name}</TableCell>
                      <TableCell>
                        <Badge
                          variant={u.role === "admin" ? "default" : "secondary"}
                          className={u.role === "admin" ? "bg-amber-500/20 text-amber-400 border-amber-500/30" : "bg-slate-800 text-slate-300"}
                        >
                          {u.role.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => updateRoleMutation.mutate({
                            userId: u.id,
                            role: u.role === "admin" ? "user" : "admin",
                          })}
                          className="text-xs text-slate-400 hover:text-white"
                        >
                          {t("toggleRole")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Jackpot Pool Controls (1 Column) */}
        <Card className="bg-slate-900/80 border-slate-800">
          <CardHeader>
            <CardTitle>{t("jackpotControls")}</CardTitle>
            <CardDescription className="text-slate-400">{t("jackpotControlsDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {jackpotPools?.map((pool) => (
              <div key={pool.tier} className="space-y-2 p-3 rounded-lg border border-slate-800 bg-slate-950/50">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold uppercase text-amber-400">{pool.tier} Jackpot</span>
                  <span className="text-sm font-mono text-slate-300">{pool.amount} BTC</span>
                </div>
                <div className="flex gap-2">
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
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Pending Transactions Queue */}
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
                  <TableHead className="text-slate-400">Player</TableHead>
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
                    </TableCell>
                    <TableCell className="font-mono text-xs text-slate-500 max-w-[140px] truncate">
                      {tx.toAddress ?? "—"}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {tx.type === "deposit" ? (
                        <Button
                          size="sm"
                          className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                          disabled={approveDepositMutation.isPending}
                          onClick={() => approveDepositMutation.mutate({ txId: tx.id })}
                        >
                          {t("approveDeposit")}
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                            disabled={approveWithdrawMutation.isPending}
                            onClick={() => approveWithdrawMutation.mutate({ txId: tx.id })}
                          >
                            {t("approvePayout")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs border-red-500/40 text-red-400 hover:bg-red-500/10"
                            disabled={rejectWithdrawMutation.isPending}
                            onClick={() => rejectWithdrawMutation.mutate({ txId: tx.id })}
                          >
                            Reject
                          </Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <GameConfigCard enabled={isAuthenticated && isAdmin} />
    </div>
  );
}
