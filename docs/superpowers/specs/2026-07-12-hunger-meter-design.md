# Hunger meter (digestion phase 2): readout line + tape fullness trace — design

**Date:** 2026-07-12
**Status:** approved (pending spec review)

## Problem

The digestion kernel (phase 1, shipped) models each feed's gradual release.
Its natural next product is an answer to the question parents actually have:
**is she hungry, and when will she be?** Nothing in the UI says this today —
the gauge compares daily totals, the gap targets are static rules.

## Approach

Two surfaces over one model core, both client-side in `src/app.html`:

- **A — readout hunger line**: a quiet marker-anchored line in the tape's
  readout block: current belly content and, when the marker rides "now", the
  predicted hunger time.
- **C — tape fullness trace**: a faint sawtooth curve on the tape's feed
  lane — fullness rising at each bottle, decaying between feeds — with the
  below-reference stretches tinted. History only: the tape's viewBox ends at
  "now" (fog past it) by design, so the *future* is the readout line's job.

No invented thresholds: "hungry" is **self-calibrated** — her stomach is
emptier than it usually is at the moments she actually gets fed.

Rejected: hunger chip in the targets ribbon (bends the ribbon's semantics —
every chip there is a server-evaluated *target*, this is a marker-anchored
*status*, and it scrolls out of view); a future "dotted stub" on the tape
(the tape ends at now; future pixels are unreachable and fogged).

## Model core

- **Fullness** at instant `t`:
  `fullnessAt(feeds, t) = Σ amountᵢ · (1 − digFrac(t − tsᵢ))` — the shipped
  kernel's complement; only feeds within the 5h truncation span contribute.
  Fullness jumps up by the amount at each feed instant and decays smoothly
  between feeds (the sawtooth).
- **Hunger reference** (calibration): for every feed in the loaded history,
  compute the fullness *just before* it (`fullnessAt` excluding the feed
  itself). Two references, split by the feed's Madrid wall-clock hour using
  the tape's own night definition (**21:00–07:00**): `refDay`, `refNight`,
  each the **median** of its class. Babies run longer gaps at night; one
  combined median would overstate night hunger.
- **Class fallbacks**: a class with **< 12** samples falls back to the
  combined median. Fewer than **20** pre-feed samples overall → the meter is
  **hidden entirely** (both surfaces) — same philosophy as the gauge's
  `FG_MIN_DAYS` gate. (First feed ever has no pre-feed sample worth keeping:
  samples where no prior feed exists within the truncation span are still
  valid — fullness 0 — and are kept; the <20 gate handles young histories.)
- **Hungry test** at instant `t`: `fullnessAt(t) < ref(classOf(t))`, where
  `classOf(t)` is day/night by `t`'s Madrid hour.
- **Prediction** (marker at now only): fullness decays deterministically with
  no future feeds; scan forward from now in 1-minute steps up to **+12 h**
  for the first `t` where the hungry test holds. Already hungry → "now";
  no crossing within 12 h → omit the prediction.
- **Cost**: references recomputed once per dashboard payload (sorted feeds +
  sliding window, O(n·k)); `fullnessAt` per call touches only the ≤5h feed
  neighborhood. Trace sampling below is the only bulk consumer.

## Surface A — readout hunger line

- **Markup**: a new `<span class="rs-hunger" data-tip="…">` appended inside
  `.rs-readout` as a **sibling after** `.rs-readout-btn` — NOT inside it
  (the button opens the jump dialog; the hunger line must not).
- **Content**, marker-anchored, rebuilt in `updateStripMarker` alongside
  rel/abs:
  - always: `belly ≈ {n} ml` (es `barriga ≈ {n} ml`) at the marker instant;
  - marker at now (`stripFollowNow`): append `· probably hungry ~17:40`
    (es `· probablemente con hambre ~17:40`), or `· probably hungry now`
    (es `… ya`) when already below the reference; no crossing in 12 h →
    no suffix;
  - marker scrubbed back: append `· probably hungry` only when the hungry
    test holds at the marker (no time — the past needs no forecast).
- **Why-caption**: `data-tip` = "usually fed when ≈ {n} ml remain ({k}
  feeds, {d} days)" with the marker-applicable reference (es "suele comer
  cuando quedan ≈ {n} ml ({k} tomas, {d} días)"). Tapping the line shows it
  in the shared tap-tip: the document click handler's chip branch widens its
  gate from `.strip-chip` to `.strip-chip, .rs-hunger` (both carry
  `data-tip`).
- **Style**: same quiet dialect as `.rs-readout-abs` (small, muted,
  tabular numerals); `≈` marks every modeled number, "probably" every claim.
- **Hidden** when the meter is gated off (<20 samples) or the marker window
  predates tracking — the span simply isn't rendered.

## Surface C — tape fullness trace

- **Placement**: an SVG path in `rhythmStripHtml`, inserted **before**
  `gauges(...)` so every mark (opaque-backed by design) paints over it;
  night rects sit below it, the fog above — the trace fades out at the
  tape's edges like everything else.
- **Geometry**: feed-lane band, y = 52 (0 ml) up to y = 24 (ceiling), i.e.
  centered on the feed lane (y=38) without touching the diaper lane (66).
  Ceiling = the max sampled fullness across the tape window (data-anchored:
  scrubbing never rescales it; it can only change on a data rebuild).
- **Sampling**: piecewise — 5-minute steps between events (15-minute on
  jump-extended tapes, `RS_DAYS > 7`, mirroring the tick-density rule) plus
  the exact feed instants twice (t⁻ and t⁺) for the vertical rise. One
  `<path class="rs-fullness">` polyline from the tape start to `nowMin`.
- **Hungry tint**: stretches where the sampled fullness sits below the
  (day/night-stepped) reference are overdrawn by `<path
  class="rs-fullness-low">` segments — crossings interpolated linearly
  between samples. The tint is the signal; no reference hairline is drawn
  (an unlabeled level line would be noise — the readout line carries the
  words).
- **Style**: `.rs-fullness` a muted hairline (border-grade, like the lane
  scaffolding); `.rs-fullness-low` feed-hue. Non-interactive
  (`pointer-events: none` grade — it must never steal the tape's mark
  taps). Both styled via the existing CSS vars, so dark/light follow free.
- **Hidden** entirely under the same <20-sample gate.

## Edge cases

- No feeds / young history: gated off (both surfaces), no layout residue.
- A feed logged at the marker instant: fullness includes it from t⁺ — the
  readout line jumps up right after logging (correct: the belly is full
  now), while the *gauge* needle still ramps (correct: little digested yet).
  These read differently on purpose; both are honest.
- Marker before the first feed: fullness 0 with no samples in range — the
  line renders `belly ≈ 0 ml` only if the meter is on and the marker is
  after tracking began; before that, hidden (matches the gauge's blanking).
- Deleted/edited feeds: everything recomputes from the payload on rebuild —
  no state to invalidate beyond the cached references (recomputed per
  payload).
- DST wall-time folds: class-of-hour uses the same `toWall` machinery as
  the tape's night shading — the two can never disagree.

## Performance

- References: one O(n·k) pass per payload (n ≈ hundreds, k = feeds within
  5h — single digits).
- Trace: ~864 samples on the 3-day tape (5-min steps), each O(k) — a few
  thousand exponentials per tape rebuild, on the same cadence as the
  existing full-SVG rebuild. Jump-extended tapes triple the step instead of
  the cost.
- Readout line: O(k) per scroll tick — negligible next to the existing
  per-scroll rebuild of the compare gauge.

## Testing

- Extend the phase-1 extract-and-eval scratch check: fullness complements
  digestion (`fullnessAt + digested-so-far = total fed` for one feed),
  sawtooth jump at the feed instant, monotone decay to 0 by 5 h, prediction
  crossing on a synthetic two-feed day, median calibration on a synthetic
  regular schedule (ref ≈ the pre-feed level by construction).
- Behavioral (`wrangler dev`, seeded): line renders and updates on scrub;
  prediction appears only with the marker at now; tap shows the why-caption;
  jump button still opens the dialog (the line is outside it); trace visible
  under the bottles, tinted where the seeded schedule ran long; `es`
  wording; both dark/light legible; <20-feed dataset hides both surfaces.

## Out of scope

- Any notification/alert (this is a glanceable estimate, not an alarm).
- Server/Alexa exposure of the model.
- Per-feed-type half-lives (feed type isn't recorded).
