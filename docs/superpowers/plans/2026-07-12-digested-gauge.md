# Digested-milk gauge mode (swipe-swappable fg rail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second "digested ml" statistics lens to the feeding gauge, swapped by swiping horizontally on it (or tapping its mode caption), per `docs/superpowers/specs/2026-07-12-digested-gauge-design.md`.

**Architecture:** Everything lands in `src/app.html` (the web app is one HTML file with inline CSS/JS; the worker serves it verbatim — no build step). A pure exponential-emptying kernel (`digFrac`/`digSumMl`) feeds the existing `stripCompareHtml` box-plot machinery when the module-level `fgDigested` lens flag is on; raw mode stays byte-identical. A pointer-event swipe handler delegated on the persistent `#today-strip` element (`stripEl`) swaps lenses, mirroring the tape-drag handlers that already live there.

**Tech Stack:** Vanilla ES5-style inline JS (match surrounding code: `var`, `function`), inline CSS with `--text`/`--muted` theme vars, no test harness for app.html (kernel verified by an extract-and-eval node script; behavior verified in `wrangler dev`).

**Note on TDD:** `app.html`'s inline script has no unit-test harness (vitest covers TS modules only — this is the codebase's existing pattern, and this plan doesn't restructure it). The kernel task uses the closest equivalent: write the verification script first, watch it fail (functions absent), then implement. UI tasks are verified behaviorally in Task 5.

**Line numbers** below are against commit `0633c92`; treat them as anchors, not gospel — always locate by the quoted code.

---

### Task 1: Digestion kernel (`digFrac`, `digSumMl`, constants, lens flag)

**Files:**
- Modify: `src/app.html` (~line 3720, right after `fgQuantile`'s closing brace, before the `// Selected baby's birth instant` comment)
- Create: `/tmp/claude-1000/-home-gllera-ws-babylog/b26c6a46-7fee-4211-bad9-70585356d927/scratchpad/dig-check.cjs` (scratch verification — NOT committed)

- [ ] **Step 1: Write the failing verification script**

Write `dig-check.cjs` in the scratchpad directory (`.cjs` on purpose: CommonJS is sloppy-mode, so direct `eval` of the extracted `var`/`function` declarations lands them in the module scope; an `.mjs` module is strict-mode and would swallow them):

```js
// Extracts the digestion kernel from src/app.html verbatim and checks the
// spec's three claims: conservation, 10-minute sensitivity bound, CDF shape.
const { readFileSync } = require("fs");
const src = readFileSync("/home/gllera/ws/babylog/src/app.html", "utf8");
const start = src.indexOf("var FG_DIG_HALF_MS");
const end = src.indexOf("// Selected baby's birth instant");
if (start < 0 || end < 0 || end < start) { console.error("kernel not found in app.html"); process.exit(1); }
eval(src.slice(start, end));

const DAY = 86400000, HOUR = 3600000, A = 210, t0 = 1000000000000;
const feed = [{ ts: new Date(t0).toISOString(), amount_ml: A }];
const close = (a, b, eps, msg) => { if (Math.abs(a - b) > eps) { console.error("FAIL", msg, a, b); process.exit(1); } };

// Conservation: adjacent windows tile the release span; slices sum to A.
let total = 0;
for (let j = 0; j < 8; j++) total += digSumMl(feed, t0 + (j - 1) * DAY, t0 + j * DAY);
close(total, A, 1e-9, "conservation across adjacent windows");

// Sensitivity: worst-case 10-minute window shift moves a total by F̂(10min)·A ≈ 0.113·A.
const shift = 10 * 60000;
const moved = digSumMl(feed, t0 - DAY + shift, t0 + shift) - digSumMl(feed, t0 - DAY, t0);
if (moved > 0.12 * A || moved <= 0) { console.error("FAIL sensitivity", moved); process.exit(1); }

// CDF shape: 0 before/at the feed, 1 at truncation, renormalized half-life point.
if (digFrac(-1) !== 0 || digFrac(0) !== 0) { console.error("FAIL zero-before-feed"); process.exit(1); }
if (digFrac(5 * HOUR) !== 1 || digFrac(6 * HOUR) !== 1) { console.error("FAIL full-at-truncation"); process.exit(1); }
close(digFrac(HOUR), 0.5 / (1 - 2 ** -5), 1e-12, "renormalized half-life point");

console.log("kernel ok");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node /tmp/claude-1000/-home-gllera-ws-babylog/b26c6a46-7fee-4211-bad9-70585356d927/scratchpad/dig-check.cjs`
Expected: `kernel not found in app.html`, exit 1.

- [ ] **Step 3: Implement the kernel in `src/app.html`**

Insert after `fgQuantile`'s closing brace (currently line 3720), before the `// Selected baby's birth instant` comment block:

```js

    // Digestion lens: the same stats computed on *digested* ml. Each feed's
    // amount is released along an exponential gastric-emptying curve, so a
    // window boundary slices a feed proportionally instead of all-or-nothing
    // — a 10-minute nudge can no longer teleport a whole bottle across a day
    // edge (docs/superpowers/specs/2026-07-12-digested-gauge-design.md).
    var FG_DIG_HALF_MS = 60 * 60 * 1000; // digestion half-life
    var FG_DIG_SPAN_HL = 5;              // truncation, in half-lives
    // Renormalizing by the truncation point credits every feed's full amount
    // eventually — conservation stays exact despite the cutoff.
    var FG_DIG_NORM = 1 - Math.pow(2, -FG_DIG_SPAN_HL);
    var fgDigested = false; // the lens: false = fed (raw sums, default), true = digested

    // Fraction of a feed digested ageMs after it was taken (0 before it).
    function digFrac(ageMs) {
      var hl = ageMs / FG_DIG_HALF_MS;
      if (hl <= 0) return 0;
      if (hl >= FG_DIG_SPAN_HL) return 1;
      return (1 - Math.pow(2, -hl)) / FG_DIG_NORM;
    }

    // Digested ml over (startMs, endMs]: each feed contributes the slice of
    // its release curve that falls inside the window.
    function digSumMl(feeds, startMs, endMs) {
      var s = 0, i, t;
      for (i = 0; i < feeds.length; i++) {
        t = new Date(feeds[i].ts).getTime();
        s += (feeds[i].amount_ml || 0) * (digFrac(endMs - t) - digFrac(startMs - t));
      }
      return s;
    }
```

- [ ] **Step 4: Run the verification script — it must pass**

Run: `node /tmp/claude-1000/-home-gllera-ws-babylog/b26c6a46-7fee-4211-bad9-70585356d927/scratchpad/dig-check.cjs`
Expected: `kernel ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/app.html
git commit -m "feat(web): exponential-emptying digestion kernel for the fg gauge"
```

---

### Task 2: Digested stats, ≈ captions, and the mode caption in `stripCompareHtml`

**Files:**
- Modify: `src/app.html` — `stripCompareHtml` (~3810–3913) and the `es` STRINGS block (~1585)

- [ ] **Step 1: Lens plumbing at the top of `stripCompareHtml`**

Replace (currently ~3819):

```js
      var today = w0.ml;
```

with:

```js
      var feeds = d.strip_feedings || [];
      var dig = fgDigested;
      // The digested lens swaps every ml for its digested slice; captions
      // carry ≈ because those numbers are modeled, not logged sums.
      var apx = dig ? "≈ " : "";
      var today = dig ? digSumMl(feeds, endMs - DAY_MS, endMs) : w0.ml;
```

Then drop the now-duplicate `feeds` declaration a few lines below — replace:

```js
      var firstFeedMs = null, feeds = d.strip_feedings || [], fi, ft;
```

with:

```js
      var firstFeedMs = null, fi, ft;
```

- [ ] **Step 2: Digested priors on the same day grid**

Replace the priors loop body (currently ~3838–3841):

```js
      for (j = 1; j <= FG_WINDOW_DAYS; j++) {
        ws = windowStats(d, endMs - j * DAY_MS, statFloor);
        if (ws != null) { priors.push(ws.ml); priorDays.push({ ml: ws.ml, j: j }); }
      }
```

with (same `windowStats` gating, so both lenses agree on which days exist):

```js
      for (j = 1; j <= FG_WINDOW_DAYS; j++) {
        ws = windowStats(d, endMs - j * DAY_MS, statFloor);
        if (ws != null) {
          var pml = dig ? digSumMl(feeds, endMs - (j + 1) * DAY_MS, endMs - j * DAY_MS) : ws.ml;
          priors.push(pml); priorDays.push({ ml: pml, j: j });
        }
      }
```

- [ ] **Step 3: ≈ on every digested caption**

Needle (currently ~3866): interpolate the prefix through `{n}` — no new i18n key:

```js
      var needle = fgMark("fg-today", pos(today), i18n("day total {n} ml", { n: apx + fgMl(today) }),
        '<span class="fg-today-cap"></span>', i18n("24h before marker"));
```

Sparse-branch ticks (currently ~3876):

```js
          ticks += fgMark("fg-tick", pos(priorDays[mi].ml), apx + fgMl(priorDays[mi].ml) + " ml", '',
            plural(priorDays[mi].j, "{n} day before marker", "{n} days before marker"));
```

Band value (currently ~3892):

```js
        '" data-v="' + escapeHtml(i18n("usual") + " " + apx + fgMl(q1) + "–" + fgMl(q3) + " ml") +
```

Median (currently ~3895):

```js
      var median = fgMark("fg-med", pos(med), i18n("median") + " " + apx + fgMl(med) + " ml", '', winMeta);
```

Whisker values (currently ~3899 and ~3904):

```js
          '" data-v="' + escapeHtml(i18n("lowest day") + " " + apx + fgMl(priors[0]) + " ml") +
```

```js
          '" data-v="' + escapeHtml(i18n("highest day") + " " + apx + fgMl(priors[priors.length - 1]) + " ml") +
```

- [ ] **Step 4: The mode caption, on both return branches**

Insert right after the `needle` declaration (before the `if (priors.length < FG_MIN_DAYS)` branch):

```js
      // The lens caption: names the active statistics and reveals the other
      // exists. Tapping it swaps too (see the document click handler) — the
      // visible fallback for the horizontal swipe.
      var modeCap = '<div class="fg-mode">' +
        '<span class="fg-mode-opt' + (dig ? '' : ' on') + '">' + escapeHtml(i18n("fed")) + '</span>' +
        '<span>·</span>' +
        '<span class="fg-mode-opt' + (dig ? ' on' : '') + '">' + escapeHtml(i18n("digested")) + '</span>' +
        '</div>';
```

Prefix BOTH returns (sparse ~3878 and full ~3908) — `'<div class="fg-gauge">' + …` becomes `modeCap + '<div class="fg-gauge">' + …`. The early `fg-empty` return (~3817) stays captionless on purpose: nothing to swap.

- [ ] **Step 5: Spanish strings**

In the `es` STRINGS block, after `"24h before marker": "24 h antes del marcador",` (~1585), add:

```js
        "fed": "tomado",
        "digested": "digerido",
```

- [ ] **Step 6: Sanity-check raw mode is untouched**

Run: `node /tmp/claude-1000/-home-gllera-ws-babylog/b26c6a46-7fee-4211-bad9-70585356d927/scratchpad/dig-check.cjs` (still `kernel ok`), then:

```bash
grep -c "fg-mode-opt" src/app.html   # expect 3 (2 in JS markup, 1 in CSS after Task 3 — here: 2)
grep -n "apx" src/app.html | wc -l   # expect 7 (1 decl + 6 uses)
```

With `dig` false, `apx` is `""` and `today`/`pml` take the exact old expressions — raw markup differs from before only by the `fg-mode` caption div.

- [ ] **Step 7: Commit**

```bash
git add src/app.html
git commit -m "feat(web): digested stats lens + mode caption in the feeding gauge"
```

---

### Task 3: CSS — mode caption, swipe surface, entry slide

**Files:**
- Modify: `src/app.html` CSS (~1048–1066)

- [ ] **Step 1: Mode caption styles + hand the top gap to the caption**

The readout's top spacing currently lives on `.fg-gauge` (`margin-top: 14px`). The caption takes it over; the gauge keeps a small gap under the caption. Replace:

```css
    .fg-gauge { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
```

with:

```css
    /* The lens caption above the rail: both stats named, the active one in
       ink. Tap it — or swipe the readout horizontally — to swap lenses. It
       owns the readout's top gap; the rail hangs 6px under it. (.fg-empty
       keeps its own margin: no caption when there is nothing to swap.) */
    .fg-mode {
      display: flex;
      gap: 6px;
      margin-top: 14px;
      font-size: 11px;
      line-height: 1;
      color: var(--muted);
    }
    .fg-mode-opt.on { color: var(--text); font-weight: 600; }
    .fg-gauge { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
```

- [ ] **Step 2: Swipe surface + slide keyframes**

Insert directly after the block above:

```css
    /* The readout is a swipe surface (lens swap): keep vertical panning
       native, keep the drag from selecting the printed labels. */
    .strip-compare {
      touch-action: pan-y;
      -webkit-user-select: none;
      user-select: none;
    }
    /* Lens-swap entry: the rebuilt gauge slides in from the swipe's side. */
    @keyframes fg-slide-l { from { transform: translateX(14px); opacity: 0.4; } }
    @keyframes fg-slide-r { from { transform: translateX(-14px); opacity: 0.4; } }
    .fg-slide-l { animation: fg-slide-l 0.18s ease-out; }
    .fg-slide-r { animation: fg-slide-r 0.18s ease-out; }
```

- [ ] **Step 3: Commit**

```bash
git add src/app.html
git commit -m "feat(web): gauge lens caption styles, swipe surface, entry slide"
```

---

### Task 4: Interactions — swap function, caption tap, horizontal swipe

**Files:**
- Modify: `src/app.html` — above `updateStripCompare` (~3915), inside it, inside the document click handler (~3485), and after the tape's `pointercancel` wiring (~4074)

- [ ] **Step 1: `fgSwapMode` + slide plumbing**

Insert immediately before `function updateStripCompare()` (~3915):

```js
    // Swap the stats lens. dir flavors the entry slide with the swipe's
    // direction; 0 = no slide (the caption tap).
    var fgSlideDir = 0;
    function fgSwapMode(dir) {
      fgDigested = !fgDigested;
      fgSlideDir = dir;
      updateStripCompare();
    }
```

Inside `updateStripCompare`, replace:

```js
      el.innerHTML = stripCompareHtml(dashboardData);
```

with:

```js
      el.innerHTML = stripCompareHtml(dashboardData);
      if (fgSlideDir) {
        var g = el.querySelector(".fg-gauge");
        if (g) g.classList.add(fgSlideDir < 0 ? "fg-slide-l" : "fg-slide-r");
        fgSlideDir = 0;
      }
```

(`fgSlideDir` is transient so the 30s tick / scrub rebuilds never replay the slide.)

- [ ] **Step 2: Caption tap swaps**

In the document click handler (~3485), after `var t = e.target;` and before the `chip` lookup, insert:

```js
      var mode = t.closest ? t.closest(".fg-mode") : null;
      if (mode) { hideTapTip(); fgSwapMode(0); return; }
```

- [ ] **Step 3: The swipe**

Insert after `stripEl.addEventListener("pointercancel", stripDragEnd);` (~4074):

```js

    // Horizontal swipe on the feeding readout swaps the stats lens (fed ⇄
    // digested). Delegated on the strip root so it survives every rebuild;
    // armed only over a readout that actually shows a gauge (.fg-empty is
    // inert). Crossing the horizontal-intent threshold swaps once and eats
    // the gesture's click in capture phase so no tap caption pops from the
    // same finger. pointerup disarms a plain tap so hover moves can never
    // measure against a stale origin; a swipe's done-flag survives just
    // long enough for its click, and the next pointerdown rewrites it.
    // (.strip-compare sits outside .rhythm-scroll, so this can't fight the
    // tape drag above — the two arms are disjoint by their closest() gates.)
    var fgSwipe = null;
    stripEl.addEventListener("pointerdown", function(e) {
      var sc = e.target.closest && e.target.closest(".strip-compare");
      fgSwipe = sc && sc.querySelector(".fg-gauge")
        ? { x: e.clientX, y: e.clientY, done: false } : null;
    });
    stripEl.addEventListener("pointermove", function(e) {
      if (!fgSwipe || fgSwipe.done) return;
      var dx = e.clientX - fgSwipe.x, dy = e.clientY - fgSwipe.y;
      if (Math.abs(dx) >= 32 && Math.abs(dx) > 2 * Math.abs(dy)) {
        fgSwipe.done = true;
        fgSwapMode(dx < 0 ? -1 : 1);
      }
    });
    stripEl.addEventListener("pointerup", function() {
      if (fgSwipe && !fgSwipe.done) fgSwipe = null; // plain tap: let its click through
    });
    stripEl.addEventListener("pointercancel", function() { fgSwipe = null; });
    document.addEventListener("click", function(e) {
      if (fgSwipe && fgSwipe.done) {
        fgSwipe = null;
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
```

- [ ] **Step 4: Commit**

```bash
git add src/app.html
git commit -m "feat(web): swipe (and caption tap) swaps the feeding gauge lens"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only; fix-ups get their own commits)

- [ ] **Step 1: Kernel + existing suites**

```bash
node /tmp/claude-1000/-home-gllera-ws-babylog/b26c6a46-7fee-4211-bad9-70585356d927/scratchpad/dig-check.cjs   # kernel ok
npm test            # existing vitest suites (alexa/growth/lib/users) all pass
npm run typecheck   # clean — app.html is not in tsc scope, this guards the TS side
```

- [ ] **Step 2: Local instance with seeded data**

```bash
npx wrangler d1 migrations apply baby-feedings --local
npx wrangler d1 execute baby-feedings --local --command "SELECT id, email FROM users; SELECT id, name, date_of_birth FROM babies;"
```

Use the seeded user's email for `DEV_USER_EMAIL`. If no baby row exists, inspect columns with `PRAGMA table_info(babies);` and insert one born ~2 months ago. Seed ~15 days of feeds (so the band renders) with a generator, e.g.:

```bash
node -e '
const DAY = 864e5, now = Date.now();
let sql = "";
for (let d = 15; d >= 1; d--)
  for (let h = 7; h <= 22; h += 3) {
    const t = new Date(now - d * DAY); t.setHours(h, (d * 7) % 60, 0, 0);
    sql += `INSERT INTO feedings (ts, amount_ml, baby_id) VALUES ("${t.toISOString()}", ${90 + ((d + h) % 5) * 10}, 1);\n`;
  }
// one big boundary-straddling feed ~24h ago: the smoothing showcase
sql += `INSERT INTO feedings (ts, amount_ml, baby_id) VALUES ("${new Date(now - DAY - 3e5).toISOString()}", 210, 1);\n`;
require("fs").writeFileSync("/tmp/claude-1000/-home-gllera-ws-babylog/b26c6a46-7fee-4211-bad9-70585356d927/scratchpad/seed.sql", sql);
'
npx wrangler d1 execute baby-feedings --local --file /tmp/claude-1000/-home-gllera-ws-babylog/b26c6a46-7fee-4211-bad9-70585356d927/scratchpad/seed.sql
DEV_USER_EMAIL=<seeded email> npx wrangler dev   # background; note the port (default 8787)
```

- [ ] **Step 3: Behavioral checklist (browser on the local URL)**

Walk the spec's list — each item observed, not assumed:

1. Default view: gauge identical to production behavior (raw stats), mode caption reads **fed** · digested with "fed" emphasized.
2. Swipe left on the readout → digested lens: caption emphasis flips, marks shift, entry slide plays. Swipe right → back. Both directions swap.
3. Tap the mode caption → swaps with no slide.
4. Tap a mark (needle/band/median/whisker) → tap caption appears; in digested mode every value carries `≈`. After a swipe, NO tap caption appears.
5. Vertical page scroll starting on the gauge still scrolls (touch-action: pan-y).
6. Scrub the tape marker slowly across the seeded big feed's 24h edge: digested needle ramps; swap to raw: needle steps. The lens survives the scrub and the 30s tick (wait one out).
7. Sparse branch: temporarily seed a fresh baby/day-2 dataset if cheap, else verify by code-reading that both branches share the gating (documented fallback — say so in the report).
8. `?lang=es` (or however LANG is set — check `var LANG`): caption reads **tomado** · digerido, values `total del día ≈ N ml`.
9. Dark scheme (devtools emulation): caption legible in both themes (`--muted`/`--text`).

- [ ] **Step 4: Record results + final commit if fixes were needed**

Any fix found here gets its own small commit (`fix(web): …`). Report the checklist outcomes honestly, including anything not verifiable locally.

---

## Self-review (done at writing time)

- **Spec coverage:** kernel (T1), lens stats + gating + ≈ + caption + es strings (T2), touch-action/user-select/slide CSS (T3), swipe + tap fallback + click suppression + rebuild survival (T4), conservation/sensitivity checks + behavioral list incl. es and sparse (T5). Axis sharing needs no task — both lenses read the untouched `fgMaxDaily`/`fgMinDaily`. Empty state needs no task — early return above all new code.
- **Placeholders:** none; every code step shows the code.
- **Consistency:** names used across tasks — `fgDigested` (T1, read in T2's `dig`), `digSumMl(feeds, start, end)` (T1/T2), `fgSwapMode(dir)` (T4 both call sites), `fgSlideDir` (T4), `.fg-mode`/`.fg-mode-opt.on` (T2 markup / T3 CSS / T4 click gate), `fg-slide-l/r` (T3 CSS / T4 classList). Priors window `(endMs−(j+1)·DAY, endMs−j·DAY]` matches `windowStats(d, endMs−j·DAY)`'s `(end−DAY, end]`.
