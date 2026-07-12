# Digested-milk gauge (second fg rail) — design

**Date:** 2026-07-12
**Status:** approved (pending spec review)

## Problem

The feeding gauge under the Today tape compares hard 24h window sums
(`windowStats`/`sumRange` in `src/app.html`). A feeding is either fully inside
or fully outside a window, so a ~10-minute timing difference — a feed logged
at 23:55 vs 00:05, or the marker scrubbed slightly — teleports the whole
amount across a boundary. With only 14 daily samples behind the band, one
210 ml flip visibly moves the needle, band, median and whiskers at once. The
stats shouldn't change drastically unless the feeding pattern really changed.

## Approach

Keep the existing raw gauge untouched and add a **second bullet rail directly
beneath it** showing the same statistics computed on **digested ml** instead
of fed ml. Each feeding's amount is released gradually after its timestamp
following an exponential gastric-emptying model, so a window boundary slices
a feed **proportionally** instead of all-or-nothing. Every cliff (scrubbing,
day boundaries, feeds aging out of the 24h window) becomes a ramp.
Conservation holds: every ml is digested at exactly one instant, so it is
credited to exactly one day, and day totals still sum to what was fed.

Rejected alternatives:

- **Replacing the raw gauge** — user explicitly wants both rails visible.
- **Boxcar smear** (spread each feed uniformly over N hours) — nearly as
  smooth, but exponential matches the physical intuition that bigger feeds
  digest more per unit time, and it directly powers the phase-2 fullness
  readout.
- **Robust axis fixes** (2nd-highest-day ceiling, Tukey-fenced whiskers) —
  they calm the *scale*, but the complaint is the 10-minute window cliff in
  the *values*; the axis is marker-independent and never had that problem.

## The digestion model

- Digested fraction of a feed at age τ: `F(τ) = 1 − e^(−λτ)`,
  `λ = ln 2 / HALF_LIFE`, with **HALF_LIFE = 60 min**. Infant gastric
  half-emptying is roughly 45–80 min (breast milk vs formula); feed type
  isn't recorded, so one constant. It is a smoothing parameter with a
  physiological story, not a medical claim.
- Truncated at **T = 5 half-lives (5 h)** and renormalized:
  `F̂(τ) = min(1, F(τ) / F(T))` for τ > 0, else 0 — each feed's full amount
  is eventually credited, keeping conservation exact despite truncation.
- Contribution of feed `(A, ts)` to window `(S, E]`:
  `A · (F̂(E − ts) − F̂(S − ts))`.
- Sensitivity: a 10-minute shift moves a window total by at most
  `A · F̂(10 min) ≈ 0.11·A`, vs `1.0·A` today — roughly 9× calmer, and the
  change is continuous instead of a step.

## Components (all client-side in `src/app.html`; no backend change)

- **Constants** next to `FG_WINDOW_DAYS`: `FG_DIG_HALF_MS` (60 min) and the
  5-half-life truncation.
- **`digFrac(ageMs)`** — the renormalized CDF above.
- **`digSumMl(feeds, startMs, endMs)`** — Σ over feeds of
  `amount · (digFrac(end−ts) − digFrac(start−ts))`. Ml only; feed *counts*
  stay discrete and are not part of the new rail.
- **`stripCompareHtml`** builds both rails in one pass. Raw computations stay
  byte-identical. The digested rail reuses the same machinery: digested
  "today" (24h ending at the marker), digested priors on the same
  `endMs − j·DAY_MS` grid, the same `born` / `statFloor` gating, the same
  `FG_MIN_DAYS` branch (sparse history renders digested ticks + needle, no
  band).
- **Shared axis**: both rails use the raw gauge's `axMin`/`axMax`
  (`fgMaxDaily`/`fgMinDaily`, unchanged). Positions are vertically
  comparable and the scale cannot move because of the model. Digested window
  sums can fringe-exceed the raw rolling max (a 24h window drains feeds from
  up to 5h before it); `pos()` already clamps to the rail end and the tap
  value stays exact — same contract as the floor clamp.
- **Markup/CSS**: `.fg-gauge` becomes end labels printed **once**, flanking a
  flex column (`.fg-rails`) of two `.fg-bullet` rails. Each rail keeps its
  own dotted `.fg-rail` axis. A tiny muted row label sits at each rail's
  left — i18n `"fed"` / `"digested"` (es: `"tomado"` / `"digerido"`) — so
  the two rails are tellable apart without tapping (elder-friendly: words,
  not hue differences).
- **Captions**: digested marks reuse the existing wording with an `≈` marking
  modeled values — e.g. `day total ≈ {n} ml`, `usual ≈ q1–q3 ml`,
  `median ≈ {n} ml`, `lowest/highest day ≈ {n} ml`. New keys get `es`
  entries in `STRINGS`. Meta suffixes (`24h before marker`,
  `{n} days before marker`) are shared unchanged.
- **No handler changes**: the shared tap caption targets
  `.fg-bullet [data-v]`, which covers the new rail's marks; `hideTapTip` on
  rebuild already runs in `updateStripCompare`.
- **Empty state**: unchanged — the single "No feeds in this window yet."
  message stands in for both rails when the marker window predates birth.
- **Data window**: the API already loads ≥ 18 days of feeds (`stripDays`),
  covering the 15-day lookback plus the 5h digestion tail — `api.ts`
  untouched.

## Edge cases

- Sparse/young history, gap days, pre-birth windows: identical branches to
  the raw gauge, so both rails always agree on *which* days exist.
- `amount_ml` 0 or null contributes 0 (same `|| 0` guard as today).
- A feed logged minutes before the marker is mostly undigested: the digested
  needle ramps in over the next hours instead of jumping. Intended and
  user-approved; the tape's feed ghost still gives instant logging feedback.
- The newest day's digested total sits a few ml under its fed total (still
  digesting) — the `≈` wording covers the discrepancy honestly.

## Performance

Adds a second O(feeds × windows) pass with two `Math.exp` per pair
(~15 windows × loaded feeds), on the same scrub/30s-tick path that already
does this shape of loop. Negligible.

## Testing

- `app.html`'s inline script has no vitest harness (existing tests cover TS
  modules only). The kernel math gets a scratch numerical check during
  implementation: conservation (contributions of one feed across adjacent
  windows sum to its amount) and the 10-minute sensitivity bound.
- Behavioral verification in the running app: scrub the marker across a feed
  near a window boundary and confirm the digested rail moves smoothly while
  the raw rail steps; sparse-history branch; pre-birth blank; `es` captions;
  tap captions anchor correctly on both rails.

## Out of scope — phase 2 (separate spec)

Hunger/fullness readout from the same model: current stomach content
`fullness(t) = Σ Aᵢ · (1 − F̂(t − tsᵢ))`, compared against the baby's own
median fullness at the moments just before past feedings — a self-calibrating
"probably hungry" hint with no invented threshold. Where it lives in the UI
and its wording are open questions deferred to that spec.
