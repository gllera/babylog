# Realistic gastric-emptying kernel + corner fullness ring — design

**Date:** 2026-07-13
**Status:** implemented (2026-07-13) — kernel verified by a scratch numerical
harness (25 checks: conservation, restored identity, shape, sublinear
volume-scaling, 10-min sensitivity ≈0.057, size-responsive forecast) and the
ring/token by a UI-logic harness over the real extracted code (19 checks) plus
a headless light/dark visual render. `tsc` + 126 vitest tests green.
One deviation: the ring is **48 px**, not ~52 px — the reserved corner slot is
48 px (`64 px door + 48 px ring + 10 px gap = 122 px readout inset`) and the
spec requires "no reservation-math change"; 52 px would push into the readout.
The centre token uses `--text` (not muted) for glance legibility.

Supersedes two same-day-2026-07-12 amendments: the hunger-meter spec's
**linear-drain** amendment (`bellyLeft`, "the mark moves at constant speed
so its pace reads at a glance") and the two-kernel split that **dropped the
`fullness + digested = fed` identity on purpose** (hunger-meter + digested-gauge
specs). Both are reopened here by explicit user decision — realism over
constant-speed glanceability, and one shared kernel over two.

## Problem

The belly meter drains **linearly to zero over a fixed 5 h span regardless of
feed size** (`bellyLeft`): a 30 ml top-up and a 210 ml bottle empty over the
identical span, at a constant rate, hitting a hard zero-corner at 5 h. That is
the least physiological part of the model, and it flattens the one output
parents actually want — *when is the next feed?* — because the "probably
hungry" forecast can't respond to how much she just ate.

Separately, the app runs **two** digestion kernels: the belly meter's linear
`bellyLeft`, and the feed gauge's exponential `digFrac` (1 h half-life). They
were split deliberately, at the cost of the `fullness + digested = fed`
conservation identity.

The user wants (a) the belly drainage made **as realistic as possible** within
the recorded data (only `amount_ml` + `ts` — feed *type* isn't recorded), and
(b) the meter's face changed from the draining **bottle tank** to a **corner
radial gauge whose hole shows the time left until the next feed**.

## Decisions (all user-chosen)

1. **Curve shape** → power-exponential (Elashoff): a soft lag right after the
   feed, a near-linear middle, an asymptotic tail — no hard zero-corner.
2. **Volume effect** → yes, **sublinearly**: a bigger feed lingers longer, a
   small top-up clears fast, under a strict-proportional relationship. So the
   forecast now responds to feed size.
3. **Scope** → **unify both kernels** (belly + gauge on one curve), restoring
   the `fullness + digested = fed` identity.
4. **Face** → a **fullness ring + countdown centre** replaces the bottle tank:
   arc = current fullness (always defined), hole = time-to-next-feed forecast
   (graceful fallback).
5. **Placement/size** → **corner, terse countdown**: a ~52 px ring in the
   bottle's existing reserved slot; the small hole carries a
   magnitude-adaptive token (`~2h` / `~40m` / `soon`); precise clock-time and
   the calibration why-line stay in the tap.

## The unified kernel

Every feed *i* (amount `Aᵢ` ml, taken at `tsᵢ`) empties along one
**volume-scaled, truncated, renormalized power-exponential** *remaining*
curve. All quantities below are client-side in `src/app.html`.

### Self-calibrated volume scale

- `M` = the **median feed volume** over the loaded window (`amount_ml` over
  `strip_feedings`, `|| 0` guarded), with a **120 ml fallback** when fewer than
  **5** non-zero feeds exist in the window. Computed once per payload (memoized
  alongside `hungerRefs`) and read by both the belly and gauge paths. It is
  deliberately independent of the 20-sample hunger gate, so the gauge's kernel
  still works in the sparse-history branch.

Volume-scaling is thus relative to *her own* typical feed — a feed bigger than
usual lingers longer than usual — so there is no invented absolute volume.

### Per-feed curve

- Time constant: **`κᵢ = κ₀ · (Aᵢ / M)^p`**, with `κ₀` fixed so a **median
  feed (`Aᵢ = M`) half-empties in `t½ = 60 min`**. From
  `remaining = exp(−(τ/κ)^β)` and `remaining = ½` at `τ = t½`:
  `κ₀ = t½ / (ln 2)^{1/β}`.
- Raw remaining fraction: `r(τ) = exp(−(τ/κᵢ)^β)` for `τ ≥ 0`.
- Truncation at `Tᵢ` where `r = ε` (`ε = 0.03`):
  `Tᵢ = κᵢ · (ln(1/ε))^{1/β}`.
- **Renormalized remaining** (exactly 1 at τ≤0, exactly 0 at τ≥Tᵢ, monotone,
  continuous):
  - `remFracᵢ(τ) = (r(τ) − ε) / (1 − ε)` for `0 < τ < Tᵢ`
  - `remFracᵢ(τ) = 1` for `τ ≤ 0`,  `remFracᵢ(τ) = 0` for `τ ≥ Tᵢ`
- **Digested fraction** is the complement: `digFracᵢ(τ) = 1 − remFracᵢ(τ)` —
  monotone 0→1, exactly 1 at `Tᵢ`.

### Parameters

All are tunable smoothing choices with a physiological story, not medical
claims; each collapses to a known model at its limit.

| Param | Value | Meaning / limit |
|---|---|---|
| `t½` | 60 min @ median feed | anchors `κ₀`; mid of the 45–80 min breast/formula range (unchanged from today's gauge half-life) |
| `β` | 1.4 | power-exponential lag; **β = 1 → today's pure exponential** |
| `p` | 0.6 | sublinear volume-scaling; **p = 0 → today's fixed span**, p = 1 → full caloric-clamp (duration ∝ volume) |
| `ε` | 0.03 | truncation floor (≈ today's `2⁻⁵` leftover); sets each feed's span `Tᵢ` and the renormalization |
| `M` | self-calibrated median feed | per-baby scale; 120 ml fallback |

Worked spans at these values (M = 120 ml): a 30 ml top-up `Tᵢ ≈ 1.4 h`, a
median feed `≈ 3.2 h`, a 210 ml bottle `≈ 4.5 h` — the "small clears fast, big
lingers, but well under 7×" behaviour that was previewed and approved.

### What each surface computes

- **Belly / hunger** (replaces `bellyLeft`):
  `fullnessAt(t) = Σ_{tsᵢ ≤ t} Aᵢ · remFracᵢ(t − tsᵢ)` — only feeds within
  their own `Tᵢ` contribute. `hungerCalib` (the self-calibrated day/night
  references and the `peak` scale) and the `hungerCrossMs` forecast use the
  **same** kernel, so the "probably hungry" test stays self-consistent and the
  forecast now moves with feed size.
- **Gauge** (replaces the global `digFrac`):
  `digSumMl(S, E) = Σᵢ Aᵢ · (digFracᵢ(E − tsᵢ) − digFracᵢ(S − tsᵢ))` — now
  per-feed, since `κ` depends on `Aᵢ`.
- **Restored identity:** for any feed already taken, remaining + digested = 1,
  so `fullness(t) + digested-so-far(t) = fed-so-far(t)` exactly.

## Guarantees preserved (the reason unification is safe)

- **Conservation** (day totals sum to what was fed): each feed's `digFracᵢ`
  reaches exactly 1 at `Tᵢ`, so every ml is credited to exactly one instant and
  one day. The per-feed renormalization is the same trick as today's
  `FG_DIG_NORM`, applied with a per-feed `κ`.
- **Window-cliff smoothing** (the gauge's whole reason to exist): a 10-minute
  window-edge shift moves a total by `Aᵢ · digFracᵢ(10 min)`. Large feeds have
  large `κ` → tiny `digFracᵢ(10 min)` (≈ 0.056 for a median feed vs today's
  0.11 — the lag makes it *smoother*). A tiny feed empties fast (larger
  fraction) but carries little ml, so absolute movement stays small; and the
  change is continuous, never a step. The exact worst-case bound is re-derived
  numerically in the tests below.
- **End-stamping / translation-invariance** (the 2026-07-12 decision record):
  preserved. Calibration still samples fullness at past feed instants using
  only inter-feed *gaps* (`tsᵢ − tsⱼ`) and amounts; `κ` depends on `amount`,
  not on absolute time, so a uniform shift of all stamps still cancels.
- **Soft lag:** β > 1 gives zero initial emptying slope — the stomach does not
  dump instantly at the feed instant.

## The corner ring (replaces the bottle tank)

The hunger meter's face becomes a **radial fullness gauge** in the top-left
corner cluster, in the bottle's existing reserved slot immediately right of the
door (`#settings-btn`).

- **Vessel:** a ~52 px SVG ring sized to fit the 64 px-tall corner band and the
  readout's existing 122 px left reservation (no reservation-math change).
  Hairline full-circle **track** (`--border`-grade). A feed-hue (`--primary`)
  **fill arc** sweeping clockwise from 12 o'clock, arc length =
  `fullnessAt(marker) / peak` — the tank's exact 0→peak scale (`peak =
  hungerCalib().peak`) — rendered with `stroke-dasharray`/`stroke-dashoffset`
  on a rotated circle. A **sliver floor** (a minimum swept fraction) so a
  non-empty belly never reads fully empty, matching the tank's floor.
- **Reserve mark:** a short muted tick across the track at the angle
  `ref / peak`, where `ref` is the calibrated usually-fed median for the marker
  instant's day/night class (`nightAt(markerMs)`) — the tank's dotted reserve
  line, gone radial. It shifts at the night boundary.
- **Hungry** (`fullness < ref`): the fill arc **and** the centre token swap
  their feed-hue/muted colour for `--danger`; the track stays hairline. Driven
  by the same `el.classList.toggle("hungry", …)` as today.
- **Centre token** — an HTML `<span>` absolutely centred over the SVG (crisper
  text and easier i18n than SVG `<text>`):
  - **marker at now** (`stripMarkerMin() >= rsNowMin()`, the readout's own
    reads-Now test — *not* `stripFollowNow`) **and a crossing exists within
    12 h** → a magnitude-adaptive countdown, `~` on every value:
    - `≥ 2 h`: `~2h`, `~2½h` (nearest half-hour)
    - `1–2 h`: `~1h`, `~1½h`
    - `15–60 min`: `~40m` (nearest 5 min)
    - `< 15 min`: `soon` (es `pronto`)
    - already under the reserve (`hungerCrossMs` returns ≤ now): `now`
      (es `ya`)
  - **otherwise** (marker scrubbed back, or no crossing in 12 h) → the belly
    ml, `≈120` (a tiny `ml` unit, `fgMl` rounding). Always shows something.
- **Real-time:** on the existing 30 s tick with the marker at now, the arc
  shrinks and the token ticks down; the no-op-html detector still short-circuits
  a parked marker's quiet ticks.
- **Tap = the precision layer** (the tap caption is essentially unchanged in
  content): `belly ≈ N ml` leads; with the marker at now the **exact clock
  time** `next feed ~17:40` (es `próxima toma ~17:40`) / `~ now` (es `~ ya`)
  rides along; the meta line carries `usually fed when ≈ N ml remain`. The tap
  gives the precision the terse face omits — the face is the glance, the tap is
  the detail.
- **Gating unchanged:** hidden (no layout residue) until `hungerCalib` returns
  references (≥ 20 pre-feed samples) and the marker is at/after `firstMs`;
  hidden on the Settings tab via the existing
  `#settings-btn.at-settings + #belly-tank` sibling selector. The element keeps
  its **`#belly-tank` id** so that selector, the document-level tap-source
  (`t.closest("#belly-tank")`), and the tap-tip anchoring are untouched — it
  simply renders a ring now. (Renaming to `#belly-ring` is possible but is
  deferred as optional churn; keeping the id minimizes risk.)
- **Design language:** a second sanctioned curved exception after the bottle;
  hairline track, domain-hue fill, muted reserve tick, danger-for-hungry — all
  via existing CSS vars, so dark/light follow free and everything else stays
  squared.

## Components (all in `src/app.html`; no backend/API/Alexa change)

- **Constants:** replace `FG_DIG_HALF_MS` / `FG_DIG_SPAN_HL` / `FG_DIG_NORM`
  with the new set — `t½` (60 min), `β` (1.4), `p` (0.6), `ε` (0.03), the
  120 ml `M` fallback, and derived `κ₀`. A small helper derives `κᵢ`, `Tᵢ`,
  and the per-feed normalization.
- **`medFeedMl(feeds)`** — median `amount_ml`, memoized per payload next to
  `hungerRefs`; the 120 ml fallback below the small-count threshold.
- **`remFrac(ageMs, amountMl, medMl)`** — the renormalized remaining curve
  above. **`bellyLeft` is removed.**
- **`fullnessAt(feeds, tMs)`** — unchanged shape, calls `remFrac` with each
  feed's amount and the memoized `M`. Its inner cutoff (today the fixed 5 h
  `FG_DIG_SPAN_HL·FG_DIG_HALF_MS`) becomes **each feed's own `Tᵢ`** (a large
  feed can run ~4.5 h; a safe global cap = the largest loaded feed's `Tᵢ`).
- **`hungerCalib(feeds)`** — same, its inner gap-window cutoff widened to `Tᵢ`
  as above; unchanged otherwise (medians, day/night classes, `peak`).
- **`hungerCrossMs(feeds, refs, nowMs)`** — unchanged logic; inherits the new
  kernel via `fullnessAt`, so the crossing responds to feed size.
- **`digestedFrac(ageMs, amountMl, medMl) = 1 − remFrac(...)`** replaces
  `digFrac`; **`digSumMl`** passes each feed's amount + `M`. Callers in
  `stripCompareHtml` read the memoized `M`.
- **`updateBellyTank()`** — now builds the ring SVG + overlaid token span
  instead of the bottle; the gating, no-op detector, and tap-tip invalidation
  are unchanged. A small **`bellyCountdownToken(...)`** produces the
  magnitude-adaptive string.
- **`bellyTankTip()`** — unchanged content (ml + clock-time forecast + why),
  reused for the tap.
- **Removed:** the bottle markup, the `bt-back` / `bt-fill` / `bt-body` /
  `bt-ref` CSS and the `.hungry .bt-fill` rule, and `BT_W` / `BT_H` / `BT_RX`;
  new `.br-*` (ring track/fill/tick) + centre-token CSS in their place.
- **i18n:** new keys for `soon` / `now` / `~{d}h` / `~{d}½h` / `~{d}m` with `es`
  entries; the existing `belly ≈ {n} ml`, `next feed ~{t}`, `next feed ~ now`,
  and `usually fed when ≈ {n} ml remain` strings stay for the tap.

## Edge cases

- **Young/sparse history (< 20 samples) or marker before `firstMs`:** ring
  absent, door alone — today's look. The gauge still computes (its `M` uses the
  120 ml fallback when fewer than 5 feeds exist).
- **`amount_ml` 0 or null:** contributes 0 (same `|| 0` guard); excluded from
  the `M` median so a stray 0 can't drag the scale.
- **Fullness fringe-exceeding `peak`** (marker at the biggest feed instant):
  the arc clamps to a full sweep; the tap ml stays exact — same clamp contract
  as the tank and the gauge's `pos()`.
- **No crossing within 12 h at now:** centre falls back to belly ml; the arc
  still reads. **Already hungry at now:** token `now`, arc red.
- **Night boundary under the marker:** reserve tick and hungry class flip
  together (both read `nightAt(markerMs)`) — they can never disagree.
- **DST folds:** `nightAt` uses the tape's own `toWall` machinery.
- **Deleted/edited feeds:** everything recomputes from the payload on rebuild;
  `M` and `hungerRefs` are memoized per payload.
- **Gauge data tail:** windows drain feeds from up to `T_max` (~4.5 h) before
  their start; the ≥ 18-day `stripDays` load already covers an hours-scale
  tail — `api.ts` untouched.

## Performance

- `M`: one median per payload (memoized). `fullnessAt`: O(feeds within `Tᵢ`) —
  single digits — with two `Math.exp`/`Math.pow` per feed. `hungerCrossMs`: the
  ≤ 720-step forward scan only when the marker rides now. `digSumMl`: the same
  O(feeds × windows) loop as today with the per-feed curve. All on the existing
  scrub / 30 s-tick / rebuild cadence. Negligible.

## Testing

`app.html`'s inline script has no vitest harness (existing tests cover the TS
modules only); the kernel gets a scratch extract-and-eval numerical check
during implementation, plus behavioural verification in `wrangler dev`.

Numerical (scratch):
- **Conservation:** for feeds of 30 / 120 / 210 ml, the per-feed digested
  contributions across adjacent windows sum to the feed's amount (`Tᵢ` differs
  per size).
- **Restored identity:** `fullnessAt(t) + Σ Aᵢ·digestedFrac(t − tsᵢ) =
  fed-so-far(t)` within float tolerance.
- **Shape:** `remFrac` is monotone decreasing, `= 1` at τ=0, `= 0` at `τ = Tᵢ`;
  a soft lag (near-flat first minutes) for β > 1.
- **Volume-scaling:** `t½(210 ml) > t½(120 ml) > t½(30 ml)`, sublinear (the
  210:30 span ratio is well under 7×).
- **10-min sensitivity:** `max_i Aᵢ·digestedFrac(10 min)` over a realistic feed
  mix stays in the smoothing regime (report the number; expect ≲ today's
  0.11·A for typical/large feeds).
- **Forecast responds to size:** the same schedule with a small vs large last
  feed yields an earlier `hungerCrossMs` for the small one.

Behavioural (`wrangler dev`, seeded):
- ring present and draining with the marker at now; the token ticks down on the
  30 s tick; scrubbing moves the arc and swaps the token to belly ml.
- reserve tick + red across the night boundary; gated states (young history,
  pre-tracking marker, Settings tab).
- tap shows the exact clock-time forecast at now, no forecast when scrubbed,
  the why-line always; `es` wording; dark + light legible; the countdown
  token legible at ~52 px.
- the **gauge** digested stats still ramp smoothly across a window edge (scrub
  a feed near a boundary) and the box-plot (needle/band/median/whiskers) is
  intact; sparse-history branch renders with the `M` fallback.

## Superseded / reopened decisions

- **Linear-drain "reads at a glance"** (hunger-meter spec, 2026-07-12):
  reopened — the ring drains at a varying, realistic speed by explicit user
  choice; the terse countdown token carries the glance instead.
- **Two kernels, identity dropped on purpose** (hunger-meter + digested-gauge
  specs): reopened — one shared kernel, identity restored.
- **End-stamping vs start/end capture** (hunger-meter decision record):
  unchanged and preserved (calibration remains translation-invariant).

## Out of scope

- Any notification/alert — the ring is a glanceable estimate, not an alarm.
- Server / Alexa exposure of the model.
- Per-feed-*type* half-lives (breast vs formula) — feed type isn't recorded.
  (Feed *volume* is now used; type is not.)
- Renaming `#belly-tank` → `#belly-ring` (optional later churn).
