# Corner Belly Tank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fg-gauge rail's hollow belly square with a draining bottle-vessel tank beside the corner settings button, per `docs/superpowers/specs/2026-07-12-belly-tank-design.md`.

**Architecture:** Everything is client-side in `src/app.html` (the app is one HTML file with inline CSS + JS; no backend change). New page-chrome element `#belly-tank` next to `#settings-btn`, rebuilt by `updateBellyTank()` from `updateStripMarker()` (the path every scrub/30s-tick/refetch already runs). The hunger model core (`bellyLeft`, `fullnessAt`, `hungerCalib`, `hungerRefs`, `nightAt`) is reused untouched; a reinstated `hungerCrossMs` forward scan powers the tap's next-feed estimate. The rail's `fg-belly` mark is then removed.

**Tech Stack:** Vanilla JS + CSS in `src/app.html` (ES5-style, `var`, i18n via `STRINGS`/`i18n()`); `wrangler dev` for behavioral verification; node scratch check for the new scan (the inline script has no vitest harness — repo precedent from the two digestion specs).

---

## File structure

- `src/app.html` — all implementation (markup near line 1420, CSS near 1288/1058, i18n near 1641, JS near 3583/4070/4144/4167)
- `docs/web-ui.md` — Today-section bullet describing the meter moves from the gauge to the tank
- `docs/superpowers/specs/2026-07-12-hunger-meter-design.md` — one-line amendment pointer
- `docs/superpowers/specs/2026-07-12-belly-tank-design.md` — status flip to implemented
- Scratch (not committed): `/tmp/claude-1000/-home-gllera-ws-babylog/f94a8ed3-2092-41b0-af50-73804a91ea27/scratchpad/tank-check.js`

---

### Task 1: Corner tank chrome (markup + CSS)

Inert on its own: the element ships `hidden` and nothing unhides it yet.

**Files:**
- Modify: `src/app.html` (markup after `#settings-btn` ~line 1420; CSS after the `#settings-btn:focus-visible` block ~line 1321; `#baby-switcher` paddings at ~1274 and ~1381)

- [x] **Step 1: Add the element after the settings button**

Find:

```html
    <span class="door-back" aria-hidden="true">&#8592;</span>
  </button>
  <div id="baby-switcher" hidden></div>
```

Replace with:

```html
    <span class="door-back" aria-hidden="true">&#8592;</span>
  </button>
  <!-- The belly tank (belly-tank spec): the corner cluster's second half —
       the tape's bottle vessel at cluster size, milk level = what's still
       in her belly at the marker. Filled by updateBellyTank(); stays
       hidden while the meter is gated (young history, marker before
       tracking). MUST stay the button's next sibling: the at-settings
       sibling selector hides it on the flyleaf. -->
  <div id="belly-tank" hidden></div>
  <div id="baby-switcher" hidden></div>
```

- [x] **Step 2: Add the tank CSS**

Insert immediately after the `#settings-btn:focus-visible { ... }` rule (line ~1321), before the flyleaf comment block:

```css
    /* The belly tank (belly-tank spec): the hunger meter's face, riding
       the corner cluster right of the door — the tape's bottle vessel
       grown to cluster size, milk level = stomach content at the marker
       on her own 0→peak fullness scale, a dotted usually-fed reserve
       line across it (dotted = scaffolding, the fg-gauge axis's
       language), and the ml in small print at its side. The left edge
       continues the door's clamp math (door left + 64px + 4px). Hidden
       on Settings via the sibling selector below — the door reads ←
       there and the flyleaf carries no live status. */
    #belly-tank {
      position: absolute;
      top: 10px;
      left: max(78px, calc(50% - 376px));
      z-index: 40;
      display: flex;
      align-items: center;
      gap: 7px;
      height: 64px;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-user-select: none;
      user-select: none;
    }
    #belly-tank[hidden] { display: none; }
    #belly-tank svg { display: block; }
    .bt-back { fill: var(--bg); }
    .bt-fill { fill: var(--primary); }
    .bt-body { fill: none; stroke: var(--border); stroke-width: 1; }
    .bt-ref { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 2; }
    .bt-num { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .bt-num small { font-size: 10px; margin-left: 1px; }
    /* Probably hungry (emptier than her usual pre-feed level): milk and
       number trade feed-hue/muted for danger — the reserve line makes
       the red self-explanatory (level under the line she usually eats
       at). The vessel outline stays hairline. */
    #belly-tank.hungry .bt-fill { fill: var(--danger); }
    #belly-tank.hungry .bt-num { color: var(--danger); }
    #settings-btn.at-settings + #belly-tank { display: none; }
```

- [x] **Step 3: Widen the baby-switcher clearance**

The chip row's left padding cleared the 64px door; the cluster is now ~150px wide. Two edits:

Line ~1274, change `padding: 12px 16px 0 90px` to `padding: 12px 16px 0 170px`:

```css
    #baby-switcher { display: flex; gap: 8px; padding: 12px 16px 0 170px; flex-wrap: wrap; max-width: 920px; margin: 0 auto; }
```

Line ~1381 (inside `@media (max-width: 640px)`), change `padding: 10px 10px 0 80px` to `padding: 10px 10px 0 160px`:

```css
      #baby-switcher { padding: 10px 10px 0 160px; }
```

- [x] **Step 4: Commit**

```bash
git add src/app.html
git commit -m "feat(web): belly-tank chrome — corner vessel element and styles"
```

---

### Task 2: Tank logic — updater, crossing scan, tap caption

**Files:**
- Modify: `src/app.html` (JS after `hungerRefs` ~line 4144; `updateStripMarker` ~4167; document click handler ~3583; STRINGS es block ~1663)

- [x] **Step 1: Add i18n keys**

In the `STRINGS` es block, right after the line `"adjusts with age": "se ajusta con la edad",` (~line 1663), insert:

```js
        // Belly tank tap captions
        "next feed ~{t}": "próxima toma ~{t}",
        "next feed ~ now": "próxima toma ~ ya",
        "usually fed when ≈ {n} ml remain": "suele comer cuando quedan ≈ {n} ml",
```

- [x] **Step 2: Add the scan + updater + tap caption builder**

Insert immediately after the `hungerRefs` function (after its closing `}` at ~line 4144), before `var stripCompareLast = null;`:

```js
    // ---- The corner belly tank (see the belly-tank spec in docs/) ----
    // The hunger meter's face: the tape's bottle vessel at cluster size,
    // milk level = fullness at the marker on her own 0→peak scale, a
    // dotted reserve line at the usually-fed reference for the marker's
    // day/night class, the ml in small print at the side. Hungry (level
    // under the line) swaps feed-hue/muted for danger.
    var BT_W = 16, BT_H = 28, BT_RX = 4.5; // vessel units in the 18x30 box

    // First instant from nowMs (1-minute steps, up to +12h) where the
    // draining fullness crosses under its own class reference — the
    // removed readout line's forecast, reinstated for the tank's tap.
    // Each step re-classes day/night so the night boundary is respected.
    // Returns nowMs when already hungry, null when nothing lands in 12h.
    function hungerCrossMs(feeds, refs, nowMs) {
      for (var k = 0; k <= 720; k++) {
        var t = nowMs + k * 60000;
        if (fullnessAt(feeds, t) < (nightAt(t) ? refs.night : refs.day)) return t;
      }
      return null;
    }

    var bellyTankLast = null; // last html handed to the tank (no-op detector)
    function updateBellyTank() {
      var el = document.getElementById("belly-tank");
      if (!el) return;
      var refs = dashboardData && hungerRefs(dashboardData);
      var endMs = markerInstant().getTime();
      // Gated off (young history / marker before tracking): door alone.
      if (!refs || endMs < refs.firstMs) {
        el.hidden = true;
        bellyTankLast = null;
        if (tapTipEl && tapTipEl.tipFor === el) hideTapTip();
        return;
      }
      var feeds = dashboardData.strip_feedings || [];
      var f = fullnessAt(feeds, endMs);
      var ref = nightAt(endMs) ? refs.night : refs.day;
      // Level with the tape bottles' sliver floor (a non-empty belly must
      // never read as empty); reserve line on the same 0→peak scale.
      var fh = f <= 0 ? 0 : Math.max(1.5, Math.min(BT_H, BT_H * f / refs.peak));
      var refY = 1 + BT_H - Math.max(0, Math.min(BT_H, BT_H * ref / refs.peak));
      var vessel = 'x="1" y="1" width="' + BT_W + '" height="' + BT_H + '" rx="' + BT_RX + '"';
      var html =
        '<svg width="18" height="30" viewBox="0 0 18 30" aria-hidden="true">' +
          '<clipPath id="bt-clip"><rect ' + vessel + '/></clipPath>' +
          '<rect class="bt-back" ' + vessel + '/>' +
          '<rect class="bt-fill" clip-path="url(#bt-clip)" x="1" y="' + (1 + BT_H - fh).toFixed(1) +
            '" width="' + BT_W + '" height="' + fh.toFixed(1) + '"/>' +
          '<rect class="bt-body" ' + vessel + '/>' +
          '<line class="bt-ref" x1="2" y1="' + refY.toFixed(1) + '" x2="' + BT_W + '" y2="' + refY.toFixed(1) + '"/>' +
        '</svg>' +
        '<span class="bt-num">≈ ' + fgMl(f) + '<small>ml</small></span>';
      el.classList.toggle("hungry", f < ref);
      el.hidden = false;
      // Unchanged html (a parked marker's tick) skips the rebuild; a
      // changed one invalidates an open caption (its estimate went stale).
      if (html === bellyTankLast && el.firstChild) return;
      bellyTankLast = html;
      if (tapTipEl && tapTipEl.tipFor === el) hideTapTip();
      el.innerHTML = html;
    }

    // Tap caption, built at tap time: the calibration story, led (marker
    // riding now) by the next-feed estimate. The past needs no forecast:
    // a scrubbed marker gets the why-caption alone.
    function bellyTankTip() {
      var refs = hungerRefs(dashboardData);
      var endMs = markerInstant().getTime();
      var why = i18n("usually fed when ≈ {n} ml remain",
        { n: fgMl(nightAt(endMs) ? refs.night : refs.day) });
      if (!stripFollowNow) return { v: why, m: null };
      var cross = hungerCrossMs(dashboardData.strip_feedings || [], refs, Date.now());
      if (cross == null) return { v: why, m: null };
      return {
        v: cross <= Date.now() ? i18n("next feed ~ now")
          : i18n("next feed ~{t}", { t: formatTimeOfDay(new Date(cross)) }),
        m: why
      };
    }
```

- [x] **Step 3: Call the updater from the marker path**

In `updateStripMarker()` (~line 4167), after `updateStripList();` add the call:

```js
      updateStripCompare();
      updateStripList();
      updateBellyTank();
```

(This covers scrub ticks, the 30s `stripTick`, refetch/`renderDashboard`, baby switch, and returning from Settings — all funnel through `updateStripMarker`.)

- [x] **Step 4: Add the tank branch to the shared tap handler**

The document click handler (~line 3583) currently reads:

```js
    document.addEventListener("click", function(e) {
      var t = e.target;
      var chip = t.closest ? t.closest(".strip-chip") : null;
      var mark = !chip && t.closest ? t.closest(".fg-bullet [data-v]") : null;
      if (!chip && !mark) { hideTapTip(); return; }
      var was = tapTipEl && tapTipEl.tipFor === (chip || mark);
      hideTapTip();
      if (was) return;
      if (chip) {
        var r = chip.getBoundingClientRect();
        showTapTip(chip, r, r.left + r.width / 2, false, chip.getAttribute("data-tip"));
      } else {
```

Change to:

```js
    document.addEventListener("click", function(e) {
      var t = e.target;
      var chip = t.closest ? t.closest(".strip-chip") : null;
      var mark = !chip && t.closest ? t.closest(".fg-bullet [data-v]") : null;
      var tank = !chip && !mark && t.closest ? t.closest("#belly-tank") : null;
      if (!chip && !mark && !tank) { hideTapTip(); return; }
      var was = tapTipEl && tapTipEl.tipFor === (chip || mark || tank);
      hideTapTip();
      if (was) return;
      if (chip) {
        var r = chip.getBoundingClientRect();
        showTapTip(chip, r, r.left + r.width / 2, false, chip.getAttribute("data-tip"));
      } else if (tank) {
        // Caption content is computed here, not baked into data-*: the
        // estimate must be fresh at tap time, not at rebuild time.
        var tr = tank.getBoundingClientRect();
        var tt = bellyTankTip();
        showTapTip(tank, tr, tr.left + tr.width / 2, false, tt.v, tt.m || undefined);
      } else {
```

(The `mark` branch stays as-is under the final `else`.)

- [x] **Step 5: Commit**

```bash
git add src/app.html
git commit -m "feat(web): corner belly tank — draining vessel, reserve line, next-feed tap"
```

---

### Task 3: Scratch numerical check of the crossing scan

Not committed — the inline script has no vitest harness; this is the repo's extract-and-eval pattern (see the two digestion specs' Testing sections).

**Files:**
- Create: `/tmp/claude-1000/-home-gllera-ws-babylog/f94a8ed3-2092-41b0-af50-73804a91ea27/scratchpad/tank-check.js`

- [x] **Step 1: Write the check**

```js
// Extract-and-eval check for hungerCrossMs (belly-tank spec).
const fs = require("fs");
const src = fs.readFileSync("src/app.html", "utf8");
function fn(name) {
  const m = src.match(new RegExp("    function " + name + "\\([\\s\\S]*?\\n    }"));
  if (!m) throw new Error(name + " not found");
  return m[0];
}
// Stubs for the extracted functions' free variables.
var FG_DIG_SPAN_HL = 5, FG_DIG_HALF_MS = 3600000;
var nightAt = function () { return false; };
eval(fn("bellyLeft"));
eval(fn("fullnessAt"));
eval(fn("hungerCrossMs"));

const MIN = 60000, t0 = 1700000000000;
// Regular schedule: 120 ml every 180 min, last feed at t0. Pre-feed
// fullness on this schedule: only the 180-min-old feed still drains
// (span 300 min) → 120·(1−180/300) = 48 ml. refs = that level.
const feeds = [];
for (let i = 0; i < 24; i++) feeds.push({ ts: new Date(t0 - i * 180 * MIN).toISOString(), amount_ml: 120 });
const refs = { day: 48, night: 48, peak: 168 };

// 1. Crossing: fullness(t0+τ) = 120·(1−τ/300) + 48·max(0,1−τ/... ) — the
// second term dies at τ=120; solve 120·(1−τ/300) < 48 → τ > 180. The
// 1-min scan must land on 181 min.
const c1 = hungerCrossMs(feeds, refs, t0);
console.assert(c1 === t0 + 181 * MIN, "crossing at +181min, got " + (c1 - t0) / MIN);

// 2. Already hungry (huge reference) → returns nowMs itself.
const c2 = hungerCrossMs(feeds, { day: 1e9, night: 1e9 }, t0);
console.assert(c2 === t0, "already-hungry returns now");

// 3. Unreachable reference (fullness can never go below 0 ≥ −1) → null.
const c3 = hungerCrossMs(feeds, { day: -1, night: -1 }, t0);
console.assert(c3 === null, "no crossing within 12h → null");

// 4. Night-boundary respect: night ref lower than day ref, nightAt flips
// at t0+60min — the scan must not cross while the (lower) night ref
// applies at pre-cross fullness. Day ref 200 crosses immediately at k
// where class is day; with night active first 60 min and ref 0, the
// first day-classed minute is 61.
nightAt = function (t) { return t < t0 + 60 * MIN; };
eval(fn("hungerCrossMs")); // rebind over the new nightAt closure scope
const c4 = hungerCrossMs(feeds, { day: 200, night: 0 }, t0);
console.assert(c4 === t0 + 60 * MIN, "class re-checked per step, got " + (c4 - t0) / MIN);

console.log("tank-check: all assertions passed");
```

- [x] **Step 2: Run it**

Run: `cd /home/gllera/ws/babylog && node /tmp/claude-1000/-home-gllera-ws-babylog/f94a8ed3-2092-41b0-af50-73804a91ea27/scratchpad/tank-check.js`
Expected: `tank-check: all assertions passed` and no `Assertion failed` lines.

---

### Task 4: Remove the rail belly mark

**Files:**
- Modify: `src/app.html` (CSS ~1058–1074; `stripCompareHtml` ~4070–4089 and the two rail concatenations; STRINGS es ~1641–1643)

- [x] **Step 1: Remove the `.fg-belly` CSS and its comment**

Delete this block (lines ~1058–1074), including the two comments:

```css
    /* The belly mark (hunger-meter spec): current stomach content as a
       hollow feed-hue square on its own 0→peak fullness scale across the
       full rail — the one mark not on the intake axis; the glyph keeps it
       tellable apart. Opaque backing (bottle treatment) so the rail never
       threads through it. */
    .fg-belly {
      position: absolute;
      top: 50%;
      width: 7px;
      height: 7px;
      transform: translate(-50%, -50%);
      background: var(--bg);
      border: 1.5px solid var(--primary);
    }
    /* Probably hungry (emptier than her usual pre-feed level): the mark
       goes danger-red. */
    .fg-belly.hungry { border-color: var(--danger); }
```

- [x] **Step 2: Remove the belly branch from `stripCompareHtml`**

Delete this block (~lines 4070–4089):

```js
      // The belly mark (hunger-meter spec): current stomach content as one
      // more tappable mark. The one mark NOT on the intake axis — it rides
      // its own 0→peak fullness scale across the full rail, a fuel needle
      // that fills at a feed and drains as she digests; the hollow square
      // glyph keeps it tellable apart from the axis marks. Gated with the
      // hunger meter (enough history, marker after tracking began).
      var belly = "";
      var hgRefs = hungerRefs(d);
      if (hgRefs && endMs >= hgRefs.firstMs) {
        var fNow = fullnessAt(feeds, endMs);
        // Emptier than she usually is when she actually gets fed → the mark
        // trades its feed hue for the page's breach ink (the chips'
        // language: loudest state without inventing an alarm color).
        var hungry = fNow < (nightAt(endMs) ? hgRefs.night : hgRefs.day);
        belly = fgMark("fg-belly" + (hungry ? " hungry" : ""),
          Math.max(0, Math.min(100, 100 * fNow / hgRefs.peak)),
          i18n("belly ≈ {n} ml", { n: fgMl(fNow) }) +
            (hungry ? " · " + i18n("probably hungry") : ""),
          '', i18n("at the marker"));
      }
```

Then drop `belly` from both rail concatenations:

`'<div class="fg-rail"></div>' + ticks + belly + needle +` → `'<div class="fg-rail"></div>' + ticks + needle +`

`'<div class="fg-rail"></div>' + whisks + band + median + belly + needle +` → `'<div class="fg-rail"></div>' + whisks + band + median + needle +`

- [x] **Step 3: Remove the orphaned i18n keys**

The mark was the only consumer of these three es entries (~lines 1641–1643) — delete them:

```js
        "belly ≈ {n} ml": "barriga ≈ {n} ml",
        "at the marker": "en el marcador",
        "probably hungry": "probablemente con hambre",
```

Verify nothing else references them: `grep -n 'belly ≈\|at the marker\|probably hungry' src/app.html` → only comments (if any) remain, no `i18n(` call sites.

- [x] **Step 4: Commit**

```bash
git add src/app.html
git commit -m "refactor(web): drop the rail belly mark — the hunger meter lives on the corner tank"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/web-ui.md` (Today bullet ~lines 27–37)
- Modify: `docs/superpowers/specs/2026-07-12-hunger-meter-design.md` (status paragraph)
- Modify: `docs/superpowers/specs/2026-07-12-belly-tank-design.md` (status line)

- [x] **Step 1: Rewrite the gauge bullet in `docs/web-ui.md`**

Replace the sentence starting `A hollow square **belly mark** rides its own 0→peak scale:` through `hidden until ~20 feeds of history).` (end of that bullet) so the bullet ends at `scrubbing the tape re-reads that window.`, and append a new bullet after it:

```markdown
- A corner **belly tank** beside the settings button: the tape's bottle
  vessel at cluster size, its milk level the stomach content at the marker
  (draining linearly to empty over 5 h) on her own 0→peak fullness scale,
  a dotted reserve line at the level she's usually fed (self-calibrated
  medians of pre-feed fullness, split by the Settings-defined day/night
  window), and the ml in small print at its side. Level under the line
  turns milk and number danger-red. Tapping it reveals the calibration
  story and — with the marker riding "now" — a next-feed estimate (the
  first crossing under the reference within 12 h). Hidden until ~20 feeds
  of history, while the marker predates tracking, and on Settings.
```

- [x] **Step 2: Amend the hunger-meter spec status**

In `docs/superpowers/specs/2026-07-12-hunger-meter-design.md`, append one sentence to the end of the **Status** paragraph:

```markdown
Final same-day move: the belly mark left the gauge rail for the corner
**belly tank** (see the belly-tank spec of this date) — a draining
bottle vessel beside the settings button with a dotted usually-fed
reserve line, whose tap carries the reinstated next-feed forecast.
```

- [x] **Step 3: Flip the belly-tank spec status**

In `docs/superpowers/specs/2026-07-12-belly-tank-design.md`: `**Status:** approved` → `**Status:** implemented`.

- [x] **Step 4: Commit**

```bash
git add docs/web-ui.md docs/superpowers/specs/2026-07-12-hunger-meter-design.md docs/superpowers/specs/2026-07-12-belly-tank-design.md
git commit -m "docs: corner belly tank — web-ui section and spec statuses"
```

---

### Task 6: Verification

**Files:** none (behavioral)

- [x] **Step 1: Existing test suite**

Run: `cd /home/gllera/ws/babylog && npm test`
Expected: all vitest suites pass (they cover TS modules; this change must not break the build or tests).

- [x] **Step 2: Behavioral pass in the running app**

Run `npx wrangler dev` (uses `.dev.vars` + local D1 with seeded data) and open the printed localhost URL:

1. Tank present beside the door with the marker at now; number matches a hand-computed `fullnessAt` from recent feeds (roughly: recent feeds' ml scaled by remaining fraction of 5h).
2. Scrub the tape back: tank level and number move with the marker; scrub before the first feed's history → tank disappears.
3. Tap the tank at now: caption shows `next feed ~HH:MM` (or `~ now` if red) with the usually-fed meta line in parentheses; tap again dismisses.
4. Scrub back, tap: why-caption only, no estimate.
5. Force hungry (scrub to a long gap): fill + number red, reserve line unmoved.
6. Settings tab: tank hidden, door reads ←; return to Today: tank back.
7. Language es: captions read `próxima toma ~…` / `suele comer cuando quedan ≈ … ml`.
8. Dark mode (OS toggle): vessel/line/number legible.
9. Gauge rail: no square left; band/median/needle/whiskers/tap captions intact.
10. Multi-baby household (if seeded): switcher chips clear the cluster.

- [x] **Step 3: Console check**

In the browser devtools console, confirm no errors during scrub/tap/tab-switch.

---

## Self-review notes

- Spec coverage: tank visuals (T1+T2), marker anchor + drain (T2 via `updateStripMarker`), reserve line + hungry state (T2), tap estimate incl. night re-classing and `~ now`/omission cases (T2 `bellyTankTip`), gating incl. Settings (T1 CSS sibling rule + T2 hidden logic), rail mark removal + i18n cleanup (T4), docs (T5), scratch check + behavioral list (T3/T6). No gaps found.
- Type consistency: `hungerRefs(d)` returns `{day, night, n, firstMs, peak}` (existing); `bellyTankTip` returns `{v, m}`; `hungerCrossMs(feeds, refs, nowMs)` → ms|null — used consistently.
- The `showTapTip(..., tt.m || undefined)` guard matches its `if (meta)` contract.
