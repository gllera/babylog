# Digested-milk gauge mode (swipe-swappable fg rail) — design

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

The gauge keeps its single rail but gains a **second statistics mode**:
alongside the current raw **fed** sums, a **digested** mode computes the same
box-plot stats on digested ml — each feeding's amount released gradually
after its timestamp following an exponential gastric-emptying model, so a
window boundary slices a feed **proportionally** instead of all-or-nothing.
Every cliff (scrubbing, day boundaries, feeds aging out of the 24h window)
becomes a ramp. Conservation holds: every ml is digested at exactly one
instant, so it is credited to exactly one day, and day totals still sum to
what was fed.

**Swiping horizontally on the gauge swaps the two modes.** The raw mode stays
byte-identical to today's gauge and remains the default.

Rejected alternatives:

- **Replacing the raw gauge with digested stats** — user wants both logics
  available.
- **Two rails stacked** (earlier draft) — superseded by the swipe swap: one
  rail, less vertical space, no shared-end-label restructure.
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
  stay discrete and play no part in the digested mode.
- **Mode state**: a module-level `fgDigested = false` (raw default). It
  survives every rebuild (30 s tick, scrub, refetch) because rebuilds re-read
  it; it resets on page load (not persisted — the raw gauge is the canonical
  view, digested is a lens).
- **`stripCompareHtml`** renders per mode. Raw mode: byte-identical
  computations and markup to today. Digested mode: the same machinery —
  digested "today" (24h ending at the marker), digested priors on the same
  `endMs − j·DAY_MS` grid, the same `born` / `statFloor` gating, the same
  `FG_MIN_DAYS` sparse branch (digested ticks + needle, no band).
- **Shared axis**: both modes use the raw `axMin`/`axMax`
  (`fgMaxDaily`/`fgMinDaily`, unchanged) — swapping never rescales the rail;
  only the marks move, which is exactly the comparison the swap invites.
  Digested window sums can fringe-exceed the raw rolling max (a 24h window
  drains feeds from up to 5h before it); `pos()` already clamps to the rail
  end and the tap value stays exact — same contract as the floor clamp.
- **Mode caption**: a tiny muted line above the rail's left edge showing both
  words with the active one emphasized — `fed · digested` (es:
  `tomado · digerido`). It names the current lens, reveals that another
  exists, and **tapping it also swaps** — the desktop/accessibility fallback
  for the swipe. New i18n keys with `es` entries.
- **Swipe gesture**: pointer events, delegated at document level on
  `.strip-compare .fg-gauge` (the tap-caption handler's pattern — survives
  every innerHTML rebuild). Horizontal intent = `|dx| ≥ 32px` and
  `|dx| > 2·|dy|`; on threshold crossing, swap once and consume the rest of
  the gesture, suppressing the synthetic click so no tap caption pops. Either
  direction swaps (two modes — direction only flavors the animation). The
  gauge area gets `touch-action: pan-y` so vertical page scrolling stays
  native while horizontal drags reach the handler. `.strip-compare` sits
  outside the tape's `.rhythm-scroll`, so the swipe cannot fight scrubbing.
- **Swap transition**: the rebuilt gauge slides in from the swipe's direction
  (short transform transition, same spirit as the tape's slide animation).
  Polish, not contract — a plain re-render is acceptable if it fights the
  rebuild path.
- **Captions**: digested marks reuse the existing wording with an `≈` marking
  modeled values — e.g. `day total ≈ {n} ml`, `usual ≈ q1–q3 ml`,
  `median ≈ {n} ml`, `lowest/highest day ≈ {n} ml`. New keys get `es`
  entries in `STRINGS`. Meta suffixes (`24h before marker`,
  `{n} days before marker`) are shared unchanged.
- **No tap-handler changes**: the shared tap caption targets
  `.fg-bullet [data-v]`, which covers digested marks; `hideTapTip` already
  runs on every rebuild via `updateStripCompare`.
- **Empty state**: unchanged — the single "No feeds in this window yet."
  message (no mode caption when there is nothing to swap).
- **Data window**: the API already loads ≥ 18 days of feeds (`stripDays`),
  covering the 15-day lookback plus the 5h digestion tail — `api.ts`
  untouched.

## Edge cases

- Sparse/young history, gap days, pre-birth windows: identical branches in
  both modes, so the two lenses always agree on *which* days exist.
- `amount_ml` 0 or null contributes 0 (same `|| 0` guard as today).
- A feed logged minutes before the marker is mostly undigested: the digested
  needle ramps in over the next hours instead of jumping. Intended and
  user-approved; the tape's feed ghost still gives instant logging feedback.
- The newest day's digested total sits a few ml under its fed total (still
  digesting) — the `≈` wording covers the discrepancy honestly.
- A swipe that begins on a mark must not leave a stale tap caption: the swap
  rebuild already calls `hideTapTip`.

## Performance

Digested mode runs the same O(feeds × windows) loop shape as raw with two
`Math.exp` per pair (~15 windows × loaded feeds), on the same scrub/30s-tick
path. Only the active mode is computed. Negligible.

## Testing

- `app.html`'s inline script has no vitest harness (existing tests cover TS
  modules only). The kernel math gets a scratch numerical check during
  implementation: conservation (contributions of one feed across adjacent
  windows sum to its amount) and the 10-minute sensitivity bound.
- Behavioral verification in the running app: swipe swaps modes both
  directions; tap on the mode caption swaps; vertical page scroll over the
  gauge still scrolls; tap captions still appear on marks and never fire on
  a swipe; mode survives scrub/30s/refetch rebuilds; scrub the marker across
  a feed near a window boundary and confirm digested moves smoothly while
  raw steps; sparse-history branch; pre-birth blank; `es` captions.

## Out of scope — phase 2 (separate spec)

Hunger/fullness readout from the same model: current stomach content
`fullness(t) = Σ Aᵢ · (1 − F̂(t − tsᵢ))`, compared against the baby's own
median fullness at the moments just before past feedings — a self-calibrating
"probably hungry" hint with no invented threshold. Where it lives in the UI
and its wording are open questions deferred to that spec.
