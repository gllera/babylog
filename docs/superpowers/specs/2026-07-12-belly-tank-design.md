# Corner belly tank (hunger meter relocation) — design

**Date:** 2026-07-12
**Status:** implemented

## Problem

The hunger meter's face is the belly mark: a 7px hollow square riding the
fg-gauge rail on its own 0→peak scale. It is easy to miss among the gauge's
intake marks, its scale is invisible (nothing says the square is not on the
ml axis), and its danger-red hungry state is a color change on a 7px glyph.
The user wants the belly readout out of the gauge and into the page chrome:
a tank icon beside the corner settings button that visibly empties as she
digests, with the number in small format at its side.

## Approach

Replace the rail's belly square with a **belly tank** in the top-left corner
cluster, immediately right of the door button (`#settings-btn`): the tape's
bottle vessel grown to corner size, whose feed-hue milk level is the milk
still in her belly, plus a small muted `≈ N ml` beside it. Tapping it
reveals the calibration story and — with the marker at now — a next-feed
estimate.

Chosen over (visual-companion session, user picks):

- **Top-right corner readout** (mirroring the door) — user chose the
  one-cluster top-left reading.
- **Literally left of the door** — on phones the door is flush with the
  page edge; the number would push the app's one fixed control off its
  anchor.
- **Text-only readouts** (bare `≈ 120 ml`, square-glyph + number, worded
  `belly ≈ 120 ml`) — superseded by the user's tank idea: the tape's own
  bottle idiom, which shows the drain instead of stating it.
- **Tank without the reserve line** — the dotted usually-fed line was kept:
  it shows hungry coming before the red lands, and makes the red
  self-explanatory (level under the line she usually eats at).

## The tank

- **Vessel**: the tape's bottle gauge grown to ~16×28 units in an 18×30
  SVG — hairline body (`--border`-grade), rounded corners (the bottle's
  sanctioned exception to the squared language), opaque `--bg` backing so
  nothing threads through it, feed-hue (`--primary`) fill clipped to the
  vessel with a flat top surface. Sits vertically centered in the 64px
  corner-cluster row.
- **Level**: `fullnessAt(feeds, markerMs) / peak`, clamped to [0, 1], with
  the tape bottles' sliver floor (~1.5 units) so a non-empty belly never
  reads as empty. `peak` is `hungerCalib().peak` — her own historical
  fullness ceiling, the same 0→peak scale the rail square used.
- **Reserve line**: a dotted hairline (`--muted`, dash 2 2) across the
  vessel at `ref / peak`, where `ref` is the calibrated usually-fed median
  for the **marker instant's day/night class** (`nightAt(markerMs)` —
  the Settings-defined window). It shifts at the night boundary; dotted
  reads as scaffolding, the fg-gauge axis's own language.
- **Number**: small muted `≈ N ml` (`fgMl` rounding, tabular numerals,
  tiny `ml` unit) at the tank's right.
- **Probably hungry** (`fullness < ref`): the milk fill and the number
  swap feed-hue/muted for `--danger`. The vessel outline stays hairline.

## Semantics

- **Marker-anchored**: the tank reads at the tape's marker instant, exactly
  like the square it replaces — scrubbing moves it; with the marker riding
  "now" it drains in real time on the existing 30s tick (linear `bellyLeft`
  drain over the 5h span).
- **Tap → next-feed estimate** (the removed readout line's forecast,
  reinstated in the tap): tapping the tank cluster opens the shared tap-tip:
  - **Marker at now** (`stripFollowNow`): value line `next feed ~17:40`
    (es `próxima toma ~17:40`) — the first instant the draining fullness
    crosses under the reference, found by a 1-minute forward scan up to
    **+12 h**, each scanned instant tested against its own day/night class.
    Already below the reserve → `next feed ~ now` (es `próxima toma ~ ya`).
    No crossing within 12 h → the estimate line is omitted.
  - **Marker scrubbed back**: no estimate — the past needs no forecast.
  - In both cases the meta line carries the calibration story:
    `usually fed when ≈ {n} ml remain` (es
    `suele comer cuando quedan ≈ {n} ml`).
  - New i18n keys with `es` entries; times in Madrid wall clock like the
    readout's.
- **Gating**: hidden (no layout residue) until `hungerCalib` returns
  references (≥20 pre-feed samples) and the marker is at/after tracking
  began (`firstMs`) — the square's exact gate. Hidden on the Settings tab
  (the door reads ← there; the flyleaf carries no live status).

## What goes away

- The `fg-belly` mark: its branch in `stripCompareHtml`, the `.fg-belly`
  CSS, and the `belly ≈ {n} ml` tap caption on the rail. The
  `"belly ≈ {n} ml"` string may go if nothing else uses it; the
  `"probably hungry"` string is reused by the tank tip only if wording
  needs it, else dropped.
- The model core stays untouched: `bellyLeft`, `fullnessAt`, `hungerCalib`,
  `hungerRefs`, `nightAt` — now feeding the tank. The gauge keeps needle,
  band, median, whiskers, and both end labels exactly as they are.

## Mechanics

- **Markup**: a new element next to `#settings-btn` in the page chrome
  (outside the tabs), positioned with the same top/left math so the cluster
  hugs the tape's left edge on wide viewports and the corner on phones.
  `#baby-switcher`'s left padding widens to clear the wider cluster.
- **Updates**: a small `updateBellyTank()` rebuilds the SVG + number,
  called from the same paths that rebuild the marker readout — scrub ticks,
  the 30s tick, refetch, baby switch, and the Settings night-window change
  (the reserve line and hungry class depend on it). Cheap: one `fullnessAt`
  plus, at now, the ≤720-step scan.
- **Tap**: the document-level click handler gains the tank cluster as one
  more tap-tip source (the chips' `data-tip` pattern). The tap-tip anchors
  to the tank; `hideTapTip` on rebuild already covers staleness.
- **Dark mode**: follows free via the existing CSS vars.
- No backend, API, or Alexa change.

## Edge cases

- Young history (<20 samples) or marker before `firstMs`: tank absent,
  door alone — today's look.
- Fullness fringe-exceeding `peak` (marker at the newest feed instant):
  clamped to full; the number stays exact.
- Night boundary under the marker: reserve line and hungry class flip
  together (both read `nightAt(markerMs)`) — they can never disagree.
- DST folds: `nightAt` uses the tape's own `toWall` machinery.
- Settings tab: cluster hidden with the tape; returning to Today rebuilds
  it fresh.
- Deleted/edited feeds: everything recomputes from the payload on rebuild;
  `hungerRefs` is already memoized per payload.

## Performance

One `fullnessAt` (O(feeds within 5h)) per rebuild; the 12h crossing scan
(720 × O(k)) only when the marker rides now. Negligible next to the
existing per-scroll gauge rebuild.

## Testing

- No vitest harness for `app.html`'s inline script (existing tests cover TS
  modules only); the crossing scan gets a scratch numerical check during
  implementation (crossing on a synthetic schedule, night-class switch
  mid-scan).
- Behavioral in `wrangler dev` with seeded data: tank present and draining
  with the marker at now; scrubbing moves it; red + reserve behavior across
  the night boundary; gated states (young history, pre-tracking marker,
  Settings tab); tap shows estimate at now, no estimate when scrubbed, why
  meta always; `es` wording; dark mode; baby-switcher clearance.

## Out of scope

- Any notification/alert (glanceable estimate, not an alarm).
- Server/Alexa exposure of the model.
- Reintroducing a readout hunger line or the tape fullness trace.
