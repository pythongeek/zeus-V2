# FIX_LOG — mighty-zeus audit remediation

Branch: `audit-fixes-2026-11` (merged ff to `feature/bd-production` for deploy)
Deployed to production: 2026-11-03, pre-deploy backup `/var/backups/apps/zeus-pre-rtpdeploy-20261103-222529.sqlite` (integrity ok, 723 spins).

Worked this batch (#1 + #2 of the RTP action plan):
- **#2 [A4/A5] FIXED+VERIFIED** — commit `d133739 fix(math): kill legacy fallback math; spins require the active certified bundle`
  - Evidence (before): `getMathConfig()` (game.ts) fell back to hardcoded `PAYOUTS`/`REEL_STRIPS`/`DEFAULT_FREE_SPINS` (the pre-registry math era, 57 production spins, 192% observed — see correction below); `ensureActiveClassicBundle` auto-activated any settings drift while stamping the *declared* RTP as its "cert"; fairness replayed classic spins against a hardcoded strip set.
  - After: engine math comes only from the active certified bundle (`getActiveCertifiedClassic` / `ensureActiveCertifiedClassicBundle`); a settings edit that skipped the RTP Lab refuses spins with `MATH_DESYNC`; first-boot bootstrap self-certifies via `certifyMath` and the publish bounds before activating; `publishMath` is the only activation door and stores the full certification breakdown; the classic fairness verifier replays the spin's OWN stamped bundle; pre-registry spins return `verified:false, unverifiable:"PRE_REGISTRY"` (hash binding still shown).
  - Tests: `bundles.test.ts` registry-lifecycle rewritten (bootstrap certifies / desync refuses / publish activates), new PRE_REGISTRY fairness test, rtp/mc/tripwire/recon/maxwin/b2 updated off the removed defaults. Suite: **47 files / 205 tests passed** (baseline 199 + 6 new).
  - Corrections recorded: (1) `is_big_win` is NOT dead — threshold is 50× bet and no spin has reached it (max observed 39×); (2) thunder IS recorded as `thunder_strike` — zero occurrences in 394 paid spins vs λ≈2 is within Poisson range (13.9%); (3) the 192% "legacy math" number was 57-spin variance — the default math simulates 94.5–97.5% at 120k spins (rtp.test.ts) — the fallback still had to die (uncertified, unversioned, unverifiable), but not because of that number.
- **#1 [A1/A2/A8] FIXED+VERIFIED** — commit `60a7c36 feat(rtplab): per-bundle RTP dashboard`
  - `api/lib/rtplab.ts computeRtpReport`: per (mode, bundle) rows — certified RTP (unit-normalized: cascade cert stores a fraction), true RTP (all wins incl. FS wins ÷ paid bets), base RTP, ±95% band from the paid-spin sample, hit rates (paid/FS), FS round counts **with zero-payout rounds**, `MIN_SAMPLE_SPINS = 5000` honesty flag, per-day detail, jackpot pools shown separately (A8). Never blended.
  - `admin.getRtpReport` (admin-gated; 401 verified unauthenticated). Admin → System card, EN/BN, horizontally scrollable at 390px (verified in a real browser, desktop + mobile viewport).
  - Live numbers now visible to the operator (staging verification call, identical on prod): cascade-v1 98.93% [66.9–131.0] cert 96.48 · classic-v2 69.00% [48.0–90.0] cert 96.04 (cert outside band → the dashboard colors it) · classic-v1 parked 177.3% [162.1–192.6] cert 95.95 · pre-registry 192.0% (cert none).
  - Tests: `rtplab.test.ts` — 4 tests (bundle separation, FS round accounting, exact band math incl. zero-variance clamp, days/jackpots).
- Production smoke (post-deploy): health ok; paytable serves the certified bundle (zeus 45/175/730, RTP 96.04, FS 5/8/12); real spin id 724 settled and stamped `zeus-classic-v2` + sha256; `admin.getRtpReport` → 401 unauthenticated; journal clean; zero JS errors in the browser session.

## Batch 2026-11-19 — mobile one-screen UX + Bangla↔BDT coupling [E-mobile]
**FIXED+VERIFIED (deployed to production, no API change, frontend-only)**
- Measured before: Spin below the fold at 360×740 (293px scroll), 731×900 (377px scroll).
- <1024px: Zeus stage + mode-banner hidden, board frame capped
  min(100%, 560px, (100dvh − 24/24.5rem)·ratio), lounge extras collapse
  behind one summary row (details, breakpoint-keyed, desktop keeps all expanded).
- LanguageToggle onSwitch: বাংলা → Bangla UI + BDT; EN → English UI + USDT.
- Verified live on production (real user session, 390×844): Spin always
  in-view, scroll need 75–82px (only the collapsed extras row), toggle
  coupling both directions, board renders, no console errors.
- Suite at deploy: 50 files / 220 tests passed.
- Note: the repo had advanced ~3 weeks (U1–U5 unified-game work by another
  session). An exploratory merge of the stale audit branch was reverted
  (git reset to U5-B4); these UX changes were re-applied cleanly on top of
  U5-B4. Commit this one.

## Batch 2026-11-19 (2) — seam-free BGM rotation [audio regression, owner re-report]
**FIXED+VERIFIED (deployed to production, commit 55f7c59, frontend-only)**
- PCM analysis (in-browser decodeAudioData): bgm-main opus/m4a decode
  identically (158.3s @48kHz, seam jump 0.011/0.025, tail≈head RMS, no
  clipping, no anomalous windows) — the FILE is clean.
- Root cause: the audible stream crossing the raw loop seam (Howler
  buffer wrap) — matches the "after a few minutes" timing exactly.
- Fix: the 3s watchdog now fades the bed out in the last ~7s of the
  track, restarts at 0 and swells back — the seam is never crossed
  audibly. Adds masterRms()/masterPeakBin() analyser tap to
  window.__zeusAudio for support diagnostics.
- Verified on production with per-second telemetry over 196s: rotation
  fired at pos 153.8, clean restart, RMS dip 0.005 → recovery 0.023,
  99% playing ratio, 92 distinct dominant FFT bins (no locked tone).
  Suite: 50 files / 220 tests passed.

## Pending (everything else from the assessment — not started this batch)
| ID | Status |
|---|---|
| A3 | PENDING — FS redesign (investigate runtime vs certified FS model; owner decision gate on target RTP/volatility before re-certification) |
| A6 | PENDING — paytable per-line-bet disclosure (EN/BN) |
| A7 | PENDING — regenerate classic v2 certificate with full breakdown (one RTP Lab publish) |
| A10 | PENDING — rejection sampling for reel stops/thunder (requires re-certification) |
| A11 | PENDING — bonus-buy pricing guard; cascade PASS-cert activation gate |
| B1 | PENDING (CRITICAL) — autoplay runaway (timers, stale closures; DB-proven) |
| B2/B3/B4/B6 | PENDING — FS banking race, jackpot-on-FS policy, idempotency cache in-txn, nonce continuity |
| C1 | PENDING (CRITICAL) — rotate APP_SECRET, purge `.env*` from tree/history |
| C2–C8 | PENDING — proxy-trust rate limits, transactional admin money ops, deposit dedupe, session revocation, ledger HMAC + 6 open recon mismatches, weekly-settlement cron, BDT withdrawals, misc hardening, identify port 8092 service |
| D1–D6 | PENDING — spin-path timer cleanup, VipWheel pointer alignment, celebration re-render storm, balance refetch, polling gates, ReelEngine resize/race |
| E1–E8 | PENDING — autoplay arm UX, tap targets, sign-out redirect, dialog disclosures, a11y, hardcoded strings, win<bet presentation |
| F1–F4 | PENDING — sanctioned-country list, KYC/age gating (owner decision), restore drill, cron dedupe, `.env.bak` removal (after C1), off-box replication, two-sided tripwire alarms |

Staging environment retained at `/opt/zeus-slot-staging` (port 3101, branch `audit-fixes-2026-11`, DB = pre-deploy copy; QA user elevated to super_admin and staging `admin_2fa_required` disabled for testing — staging only).

## Batch 2026-11-19 — Storm Zeus figure [owner request]
**FIXED+VERIFIED (deployed to production, frontend-only)**
- Old figure removed (zeus-character.webp + zeus-character-cutout.webp; git history keeps them). New figure: the owner-supplied Storm Zeus art — the "GIF" upload is a single static 360x640 frame; the hi-res 768x1024 render embedded in his Zeus_Storm.html demo is the source used. Cutout built with the 2026-10-30 pipeline (isnet mask + cleanup) plus a colour-keyed recovery of the translucent energy spear (isnet drops it; blade pixels region-locked, body-connected, soft alpha from luminance) → public/assets/zeus-storm-cutout.webp (714x964, 147 KB), served byte-identical.
- Desktop (lg+): full-body stage figure at the board's left, 160x192, no mirror (spear already on the board side), hand-lightning anchors + thunder-throw origin re-tracked to the new art.
- Mobile (<lg): the E-mobile batch had hidden Zeus entirely for the one-screen fit; he now returns as a compact waist-up bust over the board's top-right corner in a zero-height mount (one-screen fit untouched), strike shown as a spear flare instead of the cross-stage throw; hidden on short landscape viewports like the strip.
- Drive-by: src/lib/audio.ts tap-buffer field types fixed (Float32Array/Uint8Array<ArrayBuffer>) — the BGM batch had left `npm run check` red; tsc clean again.
- Suite at deploy: 50 files / 220 tests passed; journal clean; old asset 404.

## Batch 2026-11-19 — Zeus interacts with game effects [owner request]
**FIXED+VERIFIED (deployed to production, frontend-only)**
- References studied: 7x7 Zeus + Zeus Royale (owner screenshots) + Gates of Olympus pattern — Zeus full-body beside the reels on a cloud pedestal, hand lightning answering game events.
- XL stage (>=1280px): figure leaves the header strip, stands 320x432 on a cloud pedestal at the board's left, board column narrows to 780px. lg keeps the strip; mobile keeps the compact bust. Cloud pedestal added under his feet in both stage presentations.
- New "flare" mood: every ordinary win (the win-small settle path, both modes — cascade settles ride the same hook after playback) pops a 0.95s spear pulse + glow. Anticipation: 2 scatters landed with reels still turning holds the scatter charge. Idle: ambient spear flare ~every 30s while the tab is visible. Precedence strike > scatter/anticipation > flare > spin > freespins > idle.
- Suite at deploy: 50 files / 220 tests passed; tsc clean; journal clean.

## Batch 2026-11-19 — 3D Zeus inside the golden cabinet [owner request]
**FIXED+VERIFIED (deployed to production, frontend-only)**
- Owner: the xl side figure "looks separate"; asked for him inside the main golden border and a sharper, realistic 3D look.
- New art: full-body 3D-render Zeus (gold armour, blue cape, lightning spear), isnet + colour-key cutout (spearhead lightning halo recovered, 45,734 px), contrast/sharpness baked in, 615x1152 WebP 249 KB. All three presentations use it; anchors re-tracked to the new pose. Storm cutout removed (git + backup recoverable).
- Frame: at xl the stage wrapper is now a golden cabinet (the board frame's border/gradient/glow + Greek-key inner border + corner bolts) enclosing Zeus AND the board; the board's own border softens inside it. Rail figure 300x500. Below xl unchanged.
- Suite at deploy: 50 files / 220 tests passed; tsc clean; journal clean; new asset 200 at exact size, old asset 404.

## Batch 2026-11-20 — Mighty Zeus animated logo [owner request]
**FIXED+VERIFIED (deployed to production, frontend-only)**
- Owner supplied an animated Mighty Zeus emblem (studio HTML + React snippet). Built src/components/MightyZeusLogo.tsx from the studio file's master SVG by scripted HTML->JSX conversion; animation CSS moved to index.css (+ reduced-motion still rule).
- Replaced: game header brand (bolt tile + ZEUS THUNDER text -> emblem, 96px phones / 148px larger) and login card brand (bolt medallion + title -> emblem at 320px hero width). Unused CardTitle/Zap imports removed from Login.
- Cinzel Decorative (the ZEUS wordmark face) was missing from the self-hosted font kit; 700+900 latin woff2 added to public/fonts + fonts.css, matching the kit pattern.
- Suite at deploy: 50 files / 220 tests passed; tsc clean; journal clean.
