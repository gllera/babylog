# Hunger meter (readout line + tape fullness trace) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-07-12-hunger-meter-design.md`: a marker-anchored belly/hunger line in the tape readout and a fullness sawtooth trace on the tape's feed lane, both driven by the shipped digestion kernel and self-calibrated against the baby's own pre-feed fullness.

**Architecture:** Everything in `src/app.html`. Pure model functions (`fullnessAt`, `hungerCalib`, `hungerCrossMs`) live beside the digestion kernel so the existing extract-and-eval scratch check covers them. A payload-memoized `hungerRefs(d)` feeds both surfaces: `fgHungerLabel(d)` renders into a `.rs-hunger` span updated by `updateStripMarker`, and a sampled SVG polyline in `rhythmStripHtml` draws the trace under the tape marks.

**Tech Stack:** Vanilla ES5-style inline JS (`var`/`function`, match surroundings), inline CSS on the existing vars (`--border` scaffolding, `--primary` feed hue), no app.html unit harness — kernel math verified by extending the scratch `dig-check.cjs`, behavior in `wrangler dev`.

**Verified anchors** (against commit `1d1139e`): `toWall`, `formatTimeOfDay`, `markerInstant`, `stripFollowNow`, `dashboardData`, `fgQuantile`, `DAY_MS` all exist and are in scope at the insertion points. Night = wall hour ≥21 or <7, matching the tape's shading (`dayI*1440+21*60 … +31*60`). Locate edits by quoted code, not line numbers.

---

### Task 1: Model core (`fullnessAt`, `nightHour`, `hungerCalib`, `hungerCrossMs`)

**Files:**
- Modify: `src/app.html` — inside the digestion kernel block, right after `digSumMl`'s closing brace and BEFORE the `// Selected baby's birth instant` comment (the scratch check extracts up to that comment)
- Modify: `/tmp/claude-1000/-home-gllera-ws-babylog/b26c6a46-7fee-4211-bad9-70585356d927/scratchpad/dig-check.cjs`

- [ ] **Step 1: Extend the scratch check (write it failing first)**

Append to `dig-check.cjs` — note the stubs BEFORE the `eval` line so the extracted code can call them (`var` declarations, visible to sloppy-mode direct eval). Add these stubs immediately above the existing `eval(src.slice(start, end));`:

```js
// Stubs for names the hunger functions reference at call time (test treats
// UTC as wall time so night classes are deterministic).
var DAY_MS = 86400000;
var toWall = (dt) => dt;
var fgQuantile = (sorted, p) => {
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
```

And append at the end of the file:

```js
// ---- hunger meter ----
// Complement: fullness + digested-so-far = total fed, at any instant.
for (const dh of [0.3, 1, 2.5, 4.9, 6]) {
  const t = t0 + dh * HOUR;
  close(fullnessAt(feed, t) + digSumMl(feed, t0 - 1, t), A, 1e-9, "complement at +" + dh + "h");
}
// Sawtooth: 0 just before the feed, the full amount at the feed instant.
close(fullnessAt(feed, t0 - 1), 0, 1e-9, "empty before feed");
close(fullnessAt(feed, t0), A, 1e-9, "full at feed instant");
close(fullnessAt(feed, t0 + 5 * HOUR), 0, 1e-9, "empty at truncation");

// Calibration: 25 feeds of 100 ml every 3 h (noon-anchored) → pre-feed
// fullness settles at 100·(1−F̂(3h)); medians must sit on it.
const CAL = [];
for (let i = 0; i < 25; i++) CAL.push({ ts: new Date(t0 + i * 3 * HOUR).toISOString(), amount_ml: 100 });
const refs = hungerCalib(CAL);
const expect = 100 * (1 - digFrac(3 * HOUR));
if (!refs || refs.n !== 25) { console.error("FAIL calib gate", refs && refs.n); process.exit(1); }
close(refs.day, expect, 0.5, "day ref on regular schedule");
close(refs.night, expect, 0.5, "night ref on regular schedule");
if (hungerCalib(CAL.slice(0, 19)) !== null) { console.error("FAIL <20 gate"); process.exit(1); }

// Crossing: scanning forward from the last feed finds the first minute the
// fullness dips under the reference; one minute earlier it was still above.
const lastT = t0 + 24 * 3 * HOUR;
const cross = hungerCrossMs(CAL, lastT, refs);
if (cross === null) { console.error("FAIL no crossing found"); process.exit(1); }
const refAtCross = nightHour(toWall(new Date(cross)).getUTCHours()) ? refs.night : refs.day;
if (!(fullnessAt(CAL, cross) < refAtCross)) { console.error("FAIL cross not hungry"); process.exit(1); }
if (!(fullnessAt(CAL, cross - 60000) >= refAtCross)) { console.error("FAIL cross too late"); process.exit(1); }

console.log("hunger ok");
```

- [ ] **Step 2: Run it — must fail with `fullnessAt is not defined`**

Run: `node /tmp/claude-1000/-home-gllera-ws-babylog/b26c6a46-7fee-4211-bad9-70585356d927/scratchpad/dig-check.cjs`
Expected: `kernel ok` then a ReferenceError mentioning `fullnessAt`, nonzero exit.

- [ ] **Step 3: Implement the model core**

Insert in `src/app.html` after `digSumMl`'s closing brace (before `// Selected baby's birth instant`):

```js

    // ---- Hunger meter (see the hunger-meter spec in docs/) ----
    // Fullness at instant tMs: every recent feed's still-undigested
    // remainder — digSumMl's complement, so fullness + digested = fed. A
    // feed at exactly tMs counts in full (the belly fills at t⁺).
    function fullnessAt(feeds, tMs) {
      var s = 0, i, t;
      for (i = 0; i < feeds.length; i++) {
        t = new Date(feeds[i].ts).getTime();
        if (t <= tMs) s += (feeds[i].amount_ml || 0) * (1 - digFrac(tMs - t));
      }
      return s;
    }

    var FG_HGR_MIN_N = 20;     // pre-feed samples before the meter shows at all
    var FG_HGR_MIN_CLASS = 12; // per day/night class, else combined fallback
    // The tape's night band (21:00–07:00 Madrid wall) classifies feeds and
    // instants — babies run longer gaps at night, so night gets its own bar.
    function nightHour(h) { return h >= 21 || h < 7; }

    // Self-calibrated hunger references: the median fullness at the moments
    // just before her own past feeds — "hungry" means emptier than she
    // usually is when she actually gets fed. Null until enough history.
    function hungerCalib(feeds) {
      var ev = [], i, j, f;
      for (i = 0; i < feeds.length; i++)
        ev.push({ t: new Date(feeds[i].ts).getTime(), a: feeds[i].amount_ml || 0 });
      ev.sort(function(a, b) { return a.t - b.t; });
      var all = [], day = [], night = [];
      for (i = 0; i < ev.length; i++) {
        f = 0;
        for (j = i - 1; j >= 0 && ev[i].t - ev[j].t < FG_DIG_SPAN_HL * FG_DIG_HALF_MS; j--)
          f += ev[j].a * (1 - digFrac(ev[i].t - ev[j].t));
        all.push(f);
        (nightHour(toWall(new Date(ev[i].t)).getUTCHours()) ? night : day).push(f);
      }
      if (all.length < FG_HGR_MIN_N) return null;
      all.sort(function(a, b) { return a - b; });
      day.sort(function(a, b) { return a - b; });
      night.sort(function(a, b) { return a - b; });
      var med = fgQuantile(all, 0.5);
      return {
        day: day.length >= FG_HGR_MIN_CLASS ? fgQuantile(day, 0.5) : med,
        night: night.length >= FG_HGR_MIN_CLASS ? fgQuantile(night, 0.5) : med,
        n: all.length,
        days: Math.max(1, Math.round((ev[ev.length - 1].t - ev[0].t) / DAY_MS)),
        firstMs: ev[0].t
      };
    }

    // First instant at/after fromMs where the hungry test holds (fullness
    // below the instant's day/night reference). 1-minute scan, 12 h
    // horizon; null = no crossing on the horizon.
    function hungerCrossMs(feeds, fromMs, refs) {
      var m, t, ref;
      for (m = 0; m <= 720; m++) {
        t = fromMs + m * 60000;
        ref = nightHour(toWall(new Date(t)).getUTCHours()) ? refs.night : refs.day;
        if (fullnessAt(feeds, t) < ref) return t;
      }
      return null;
    }
```

- [ ] **Step 4: Run the check — `kernel ok` + `hunger ok`, exit 0**
- [ ] **Step 5: Commit**

```bash
git add src/app.html
git commit -m "feat(web): hunger model core — fullness, self-calibrated references, crossing scan"
```

---

### Task 2: Readout hunger line

**Files:**
- Modify: `src/app.html` — `rhythmStripHtml`'s readout markup, CSS after `.rs-readout-abs`, new functions above `updateStripCompare`, wiring in `updateStripMarker`, the document click handler's chip gate, the `es` STRINGS block

- [ ] **Step 1: Markup — the span, sibling AFTER the jump button**

In `rhythmStripHtml`'s return, replace:

```js
        '<div class="rs-readout">' +
          '<button type="button" class="rs-readout-btn" data-strip="jump-open"' +
            ' title="' + escapeHtml(jumpLbl) + '" aria-label="' + escapeHtml(jumpLbl) + '">' +
            '<span class="rs-readout-rel"></span>' +
            '<span class="rs-readout-abs"></span>' +
          '</button>' +
        '</div>' +
```

with:

```js
        '<div class="rs-readout">' +
          '<button type="button" class="rs-readout-btn" data-strip="jump-open"' +
            ' title="' + escapeHtml(jumpLbl) + '" aria-label="' + escapeHtml(jumpLbl) + '">' +
            '<span class="rs-readout-rel"></span>' +
            '<span class="rs-readout-abs"></span>' +
          '</button>' +
          '<span class="rs-hunger" hidden></span>' +
        '</div>' +
```

- [ ] **Step 2: CSS — directly after the `.rs-readout-abs` rule**

```css
    /* The hunger line (hunger-meter spec): belly content at the marker,
       hunger forecast when the marker rides "now". A sibling of the jump
       button on purpose — tapping it explains itself (shared tap-tip)
       instead of opening the dialog. Same quiet dialect as the abs line;
       right edge aligned with the button's 48px text pad. */
    .rs-hunger {
      display: block;
      padding: 0 48px 4px 0;
      font-size: 13px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      cursor: pointer;
    }
    .rs-hunger[hidden] { display: none; }
```

- [ ] **Step 3: Label builder + payload-memoized references, inserted right above `function updateStripCompare()`**

```js
    // Hunger references are payload-derived; memoized on the feeds array's
    // identity so scroll ticks never re-run the calibration.
    var fgHungerFor = null, fgHungerRefs = null;
    function hungerRefs(d) {
      var feeds = d.strip_feedings || [];
      if (feeds !== fgHungerFor) { fgHungerFor = feeds; fgHungerRefs = hungerCalib(feeds); }
      return fgHungerRefs;
    }

    // The readout's hunger line. Null hides it: too little history for an
    // honest calibration, or the marker predates tracking (the gauge's
    // blanking philosophy). Prediction only with the marker at "now" — the
    // past needs no forecast.
    function fgHungerLabel(d) {
      var refs = hungerRefs(d);
      if (!refs) return null;
      var t = markerInstant().getTime();
      if (t < refs.firstMs) return null;
      var feeds = d.strip_feedings || [];
      var f = fullnessAt(feeds, t);
      var ref = nightHour(toWall(new Date(t)).getUTCHours()) ? refs.night : refs.day;
      var text = i18n("belly ≈ {n} ml", { n: fgMl(f) });
      if (f < ref) {
        text += " · " + i18n(stripFollowNow ? "probably hungry now" : "probably hungry");
      } else if (stripFollowNow) {
        var cross = hungerCrossMs(feeds, t, refs);
        if (cross != null)
          text += " · " + i18n("probably hungry ~{t}", { t: formatTimeOfDay(new Date(cross)) });
      }
      return {
        text: text,
        tip: i18n("usually fed when ≈ {n} ml remain ({k} feeds, {d} days)",
          { n: fgMl(ref), k: refs.n, d: refs.days })
      };
    }
```

- [ ] **Step 4: Wire into `updateStripMarker`** — after the `.rs-readout-abs` line, before `updateStripCompare();`:

```js
      var hg = document.querySelector("#today-strip .rs-hunger");
      if (hg && dashboardData) {
        var hl = fgHungerLabel(dashboardData);
        hg.hidden = !hl;
        hg.textContent = hl ? hl.text : "";
        if (hl) hg.setAttribute("data-tip", hl.tip);
      }
```

- [ ] **Step 5: Widen the tap-caption gate** — in the document click handler, replace

```js
      var chip = t.closest ? t.closest(".strip-chip") : null;
```

with

```js
      var chip = t.closest ? t.closest(".strip-chip, .rs-hunger") : null;
```

- [ ] **Step 6: Spanish strings** — after `"24h before marker": "24 h antes del marcador",`:

```js
        "belly ≈ {n} ml": "barriga ≈ {n} ml",
        "probably hungry now": "probablemente con hambre ya",
        "probably hungry": "probablemente con hambre",
        "probably hungry ~{t}": "probablemente con hambre ~{t}",
        "usually fed when ≈ {n} ml remain ({k} feeds, {d} days)":
          "suele comer cuando quedan ≈ {n} ml ({k} tomas, {d} días)",
```

- [ ] **Step 7: Commit**

```bash
git add src/app.html
git commit -m "feat(web): hunger line in the tape readout — belly content + forecast"
```

---

### Task 3: Tape fullness trace

**Files:**
- Modify: `src/app.html` — `rhythmStripHtml` (insert before `svg += gauges(d.strip_feedings || []);`), CSS next to the `.rs-lane` rule

- [ ] **Step 1: CSS — after the `.rs-lane` rule**

```css
    /* Fullness trace (hunger-meter spec): the belly-content sawtooth along
       the feed lane — hairline scaffolding like the lanes, with the
       below-reference stretches in the feed hue (the tint IS the signal;
       no reference line is drawn). Never interactive: the marks own the
       taps. */
    .rs-fullness { fill: none; stroke: var(--border); stroke-width: 1; pointer-events: none; }
    .rs-fullness-low { fill: none; stroke: var(--primary); stroke-width: 1.5; pointer-events: none; }
```

- [ ] **Step 2: The trace builder** — insert in `rhythmStripHtml` immediately before `svg += gauges(d.strip_feedings || []);`:

```js
      // Fullness trace (hunger-meter spec): belly content sampled along the
      // tape — up at each bottle, decaying between — drawn before the marks
      // so their opaque backings paint over it; the edge fog fades it out
      // like everything else. Wall-minute space end to end (the night
      // shading's space), so a DST fold distorts one night twice a year —
      // accepted. Same gate as the readout line.
      var hgRefs = hungerRefs(d);
      if (hgRefs) {
        var hev = [], hgi, hgm;
        for (hgi = 0; hgi < (d.strip_feedings || []).length; hgi++) {
          hgm = evMin(d.strip_feedings[hgi].ts);
          if (hgm <= nowMin) hev.push({ m: hgm, a: d.strip_feedings[hgi].amount_ml || 0 });
        }
        hev.sort(function(a, b) { return a.m - b.m; });
        // Sample minutes: the step grid plus each feed twice (a hair before
        // for the pre-jump value, the minute itself for the post-jump one).
        var hgStep = RS_DAYS > 7 ? 15 : 5, hgSpan = FG_DIG_SPAN_HL * 60;
        var hgMins = [];
        for (hgm = 0; hgm <= nowMin; hgm += hgStep) hgMins.push(hgm);
        for (hgi = 0; hgi < hev.length; hgi++) {
          if (hev[hgi].m > 0) hgMins.push(hev[hgi].m - 0.001, hev[hgi].m);
        }
        hgMins.sort(function(a, b) { return a - b; });
        // One ascending pass; hev[lo..up) = feeds live at the sample minute.
        var hgPts = [], lo = 0, up = 0, hgF, hgMax = 0, k;
        for (hgi = 0; hgi < hgMins.length; hgi++) {
          hgm = hgMins[hgi];
          while (up < hev.length && hev[up].m <= hgm) up++;
          while (lo < up && hgm - hev[lo].m >= hgSpan) lo++;
          hgF = 0;
          for (k = lo; k < up; k++) hgF += hev[k].a * (1 - digFrac((hgm - hev[k].m) * 60000));
          hgPts.push({ m: hgm, f: hgF });
          if (hgF > hgMax) hgMax = hgF;
        }
        if (hgMax > 0) {
          // 0 ml at y=52 up to the tape-window max at y=24: the feed lane's
          // band, clear of the diaper lane.
          var hgY = function(f) { return (52 - 28 * f / hgMax).toFixed(1); };
          var hgRef = function(m) {
            return nightHour(Math.floor(m / 60) % 24) ? hgRefs.night : hgRefs.day;
          };
          var hgD = "", hgLow = "", inLow = false, p, q, xr, seg;
          for (hgi = 0; hgi < hgPts.length; hgi++) {
            p = hgPts[hgi];
            hgD += (hgi ? "L" : "M") + x(p.m) + " " + hgY(p.f);
          }
          // Below-reference stretches, crossings interpolated between samples
          // (the reference of the earlier sample stands in across a step —
          // sub-step precision is cosmetic here).
          for (hgi = 0; hgi + 1 < hgPts.length; hgi++) {
            p = hgPts[hgi]; q = hgPts[hgi + 1];
            var pb = p.f < hgRef(p.m), qb = q.f < hgRef(p.m);
            if (pb && !inLow) { hgLow += "M" + x(p.m) + " " + hgY(p.f); inLow = true; }
            if (pb && qb) { hgLow += "L" + x(q.m) + " " + hgY(q.f); }
            else if (pb !== qb) {
              seg = (hgRef(p.m) - p.f) / (q.f - p.f);
              xr = p.m + (q.m - p.m) * seg;
              if (pb) { hgLow += "L" + x(xr) + " " + hgY(hgRef(p.m)); inLow = false; }
              else { hgLow += "M" + x(xr) + " " + hgY(hgRef(p.m)) + "L" + x(q.m) + " " + hgY(q.f); inLow = true; }
            }
            else inLow = false;
          }
          svg += '<path class="rs-fullness" d="' + hgD + '"/>';
          if (hgLow) svg += '<path class="rs-fullness-low" d="' + hgLow + '"/>';
        }
      }
```

- [ ] **Step 3: Sanity + commit**

Run: `node …/dig-check.cjs` (still `kernel ok` + `hunger ok`), then:

```bash
git add src/app.html
git commit -m "feat(web): fullness sawtooth trace on the tape's feed lane"
```

---

### Task 4: End-to-end verification

- [ ] **Step 1:** scratch check, `npm test` (122), `npm run typecheck` — all green.
- [ ] **Step 2:** `DEV_USER_EMAIL=gabriellleragarcia@gmail.com npx wrangler dev` (background) against the existing seeded local D1 (≈216 feeds).
- [ ] **Step 3:** Browser checklist — observed, not assumed:
  1. Hunger line renders under the readout: `belly ≈ N ml · probably hungry ~HH:MM` (or `now`), and the trace sawtooth is visible on the feed lane under the bottles, tinted where the schedule ran long.
  2. Scrub back: the line updates, forecast suffix disappears (state only); return to now: forecast returns.
  3. Tap the hunger line → tap-tip with the "usually fed when ≈ …" caption; tap the readout time → jump dialog still opens (the line is outside the button).
  4. `LANG = "es"` re-render: `barriga ≈ … · probablemente con hambre …`.
  5. Trace does not intercept taps on feed bottles/diaper marks.
  6. <20-feed gate: verify by code-reading (`hungerCalib` returns null → span hidden, no trace) and, cheaply if possible, by pointing `hungerRefs` at a truncated feeds array in the console.
  7. No console errors.
- [ ] **Step 4:** Fixes (if any) get their own `fix(web): …` commits; report honestly what was and wasn't verified.

---

## Self-review (done at writing time)

- **Spec coverage:** model core incl. gates and day/night split (T1), readout line incl. sibling placement, tap-tip gate widening, es strings, hidden states (T2), trace incl. under-marks draw order, wall-space, step widening on deep tapes, tint segments, no-hairline decision (T3), tests/behavioral (T1/T4). "Marker before tracking hides the line" → `firstMs` check in `fgHungerLabel`. Trace future stub: explicitly not built (spec: rejected).
- **Placeholders:** none — every code step carries the code.
- **Consistency:** `nightHour(h)` used in calib (feed wall hour), label (marker), crossing (scan instant), trace (`floor(m/60)%24` — wall minutes, same space as the night rects). `refs.firstMs`/`n`/`days` produced by `hungerCalib` and consumed by `fgHungerLabel` only. `hungerRefs(d)` shared by label and trace. `fullnessAt(feeds, tMs)` signature uniform across call sites.
