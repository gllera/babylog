# Belly chip (`br-disc`) interface refinements — design

**Date:** 2026-07-13
**Status:** approved (2026-07-13) — implementing.

Refines the corner belly chip (`.br-disc` / `#belly-tank`) shipped by the
[realistic-belly-ring](2026-07-13-realistic-belly-ring-design.md) work. The
kernel, gating, tap caption, marker-relative reading, and the calm→amber "feed
me" language are all unchanged. Four contained changes to the chip's *face*.

## Problem

The chip is a good glance but four things read weakly:

1. **Countdown format.** `bellyCountdownToken` renders decimal hours in
   half-hour steps, floored at 0.5 h (`~0.5h`, `~1.5h`). Under an hour, minutes
   are how parents think (`~30m` beats `~0.5h`); and the 0.5 h floor collapses
   the whole 0–29 min window — the most time-critical one — into a single
   `~0.5h` that then jumps straight to `now`. The *least* resolution sits where
   it matters *most*.
2. **No "how full now."** The face carries only the countdown; "just fed, 2 h
   out" and "nearly empty, 2 h out" look identical without tapping. The old
   radial arc carried fullness; the chip dropped it.
3. **Two states, no runway; `now` never escalates.** calm→amber is binary — a
   glance sees calm-calm-**amber** with no lead time. And once due the face
   reads a flat `now` forever; a 90-min nap looks freshly due.
4. **`min-width: 61px` is fragile.** It is the hand-measured pixel width of
   exactly `~0.5h`…`~9.5h` in one locale/format. Any format or locale change
   (this spec's, or `es`) silently breaks the "flip doesn't resize" promise.

## Decisions (all user-approved)

### 1. Minute/hour countdown ladder

Resolution tightens as the feed nears. A shared duration formatter
`brDurToken(ms, prefix)` (prefix `~` for the forecast, `+` for overdue):

| Time to next feed | Face | Rounding |
|---|---|---|
| Overdue > 10 min | `+45m`, `+1h30` | 5 min < 1 h, 15 min ≥ 1 h |
| Due (0–10 min over) | `now` (es `ya`) | — |
| < 60 min out | `~30m`, `~15m`, `~5m` (floor `~5m`) | nearest **5 min** |
| ≥ 60 min out | `~1h`, `~1h30`, `~2h` | nearest **15 min** |
| no crossing in 12 h | `≈120ml` (unchanged) | — |

- On-the-hour drops the minutes (`~2h`, never `~2h00`); above an hour the
  trailing minutes are only ever 15/30/45.
- The unit letter (`h`/`m`) keeps the existing small-baseline `.br-unit`
  treatment; digits stay full size. `~1h30` renders `~1` + small `h` + `30`
  (time-like); `~30m` renders `~30` + small `m`. Built in code (numeric,
  universal unit letters) — no new i18n keys; only `now`/`ya` is translated.
- **Overdue** (`hungerCrossMs` ≤ marker): reuse `hungerCrossPastMs` (the same
  source the tap uses) for the crossing instant; `elapsed = marker − crossing`.
  `elapsed < 10 min` → `now`; else `+`-prefixed via `brDurToken`. `null`
  (calibration noise) → bare `now`.
- Everything stays **marker-relative** (measured from `markerInstant()`), so a
  scrubbed-past marker still reads the forecast/overdue she had then.

### 2. Depleting fullness underline (`.br-level`)

Returns "how full now" without the radial gauge:

- A **2 px hairline bar** on the chip's bottom edge, `width =
  clamp(fullnessAt(marker) / refs.peak, floor, 1)` (the ring's old 0→peak
  scale; `peak` = p90 of fullness maxima), with a small **sliver floor** so a
  non-empty belly never reads fully empty.
- **`currentColor` at low opacity** — tracks the chip's ink (dark on calm light,
  light on calm dark, dark on amber), theme-following, introducing **no new
  hue**, so "amber is the only warm surface" holds.
- Absolutely positioned inside a now-`position: relative` `.br-disc`; width set
  inline on the patch path and eased (`transition: width 220ms`, dropped under
  reduced-motion), matching the chip's existing colour ease.
- A **distinct class** from the removed radial parts (`.br-fill`/`.br-track`/
  `.br-tick` stay absent — this is a hairline level bar, not a resurrected
  gauge).

### 3. Warm-up runway + overdue escalation

- **Warm-up:** in the final **10 min** before due (`!hungry && cross != null &&
  0 < cross − marker ≤ 10 min`) a `warming` class eases the chip to a **pale
  honey** (a tint between calm and the due `#e0b566`), via the existing 220 ms
  colour ease. At due, `hungry` takes the full amber. The classes are mutually
  exclusive by construction. Glance reads calm → pale → amber — lead time.
- **Overdue escalation:** handled by decision 1's `+` branch — past the 10-min
  grace the face counts up (`+45m`, `+1h30`) instead of a flat `now`.

### 4. `min-width` robustness

Replace `.br-disc { min-width: 61px }` with `.br-token { min-width: 4.5ch }` —
content-relative to the token's own tabular 14 px font, sized to hold the common
wide token (`~1h30` / `+1h30`). Short tokens (`now`, `~5m`) pad out to it; the
rare `≈120ml` fallback grows past it. Survives the new formats and `es`, which
the measured pixel would not.

## Components (all in `src/app.html`; no backend/API/Alexa/i18n-key change)

- **`brDurToken(ms, prefix)`** — new helper: the 5-min/15-min ladder above,
  returning the `<i class="br-unit">`-wrapped string. Floor `~5m` on the minute
  branch; `mins` rounding to 5 that reaches ≥ 60 falls through to the hour
  branch (so 58 min → `~1h`, never `~60m`).
- **`bellyCountdownToken(feeds, refs, ml)`** — signature unchanged (keeps the
  DOM-free unit tests clean). Countdown branch calls `brDurToken(cross−now, "~")`;
  the `cross ≤ now` branch computes overdue via `hungerCrossPastMs` →
  `now`/`+`. ml fallback unchanged.
- **`updateBellyTank()`** — computes `cross` once for the `warming` decision;
  `el.classList.toggle("warming", warming)` beside the existing `hungry` toggle
  (both before the no-op short-circuit, so the eased tint applies on quiet
  ticks). Builds `<span class="br-disc"><span class="br-level"></span><span
  class="br-token"></span></span>`; sets `.br-level` width on the patch path.
  aria-label logic unchanged (it already appends the stripped token).
- **CSS:** `.br-disc` gains `position: relative`, loses `min-width`; `.br-token`
  gains `min-width: 4.5ch`; new `.br-level` (absolute hairline, eased width,
  reduced-motion off); new `#belly-tank.warming .br-disc` pale-honey rule
  (light + dark). Refresh the stale block comment at the `BR_EMPTY_ML` region
  (it still describes an older "feed-hue circle → danger red" chip) and extend
  the `.br-disc` CSS comment for the underline/warming/`ch` width.

## Edge cases

- **Scrubbed-past marker:** underline, warming, token all read the marker
  instant (consistent with today's `hungry`/token behaviour).
- **`refs.peak` guard:** `hungerCalib` already returns `null` (chip gated off)
  when `peak ≤ 0` (volumeless history), so `fullness/peak` can't divide by zero
  on the render path.
- **Fullness > peak** (marker at the biggest feed): width clamps to 100%, same
  clamp contract as the old arc.
- **Overdue `hungerCrossPastMs` null** (whole 12 h window under ref —
  calibration noise): face stays bare `now`, no false `+` claim.
- **Warming ⇔ hungry never disagree:** `warming` is gated `!hungry`.
- **Reduced motion:** the `.br-level` width transition and the chip colour
  transition are both dropped (existing media rule extended).

## Testing

DOM/logic via the existing `test/belly-ring.dom.test.ts` harness
(`test/app-inline.ts` slices `brDurToken` + the ring fns into a jsdom sandbox):

- **Token ladder:** `brDurToken`/`bellyCountdownToken` map representative
  crossing distances to `~5m` (floor), `~30m`, `~55m`, `~1h` (from 58 min),
  `~1h30`, `~2h`; on-the-hour has no trailing minutes.
- **Overdue:** ≤ 10 min over → `now`; > 10 min → `+`-prefixed via the same
  ladder; `hungerCrossPastMs`-null → bare `now`.
- **Underline:** `.br-level` present, width ~`fullness/peak`, sliver-floored
  when non-empty, ~100% clamped past peak; the radial classes stay absent.
- **Warming:** `warming` class on within 10 min of the crossing and not hungry;
  off when hungry, when > 10 min out, and when gated.
- **Robustness:** the update existing tests to the new format strings (the
  `~X.Xh` asserts become the minute/hour ladder).

Then `tsc` + the full vitest suite green, plus a headless light/dark render of
`app.html` (the on-box cached-chromium path) to eyeball the chip states.

## Out of scope

- The two "Minor" notes from review (advertising the chip's tappability; the
  ml-fallback-vs-hours same-face ambiguity) — not requested.
- Any kernel, gating, tap-caption, notification, or server/Alexa change.
