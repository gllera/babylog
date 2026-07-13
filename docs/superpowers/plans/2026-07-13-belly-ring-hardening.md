# Belly-Ring Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the belly-ring feature shipped 2026-07-13 (see `docs/superpowers/specs/2026-07-13-realistic-belly-ring-design.md`): lock its math under vitest, self-calibrate the emptying speed from the baby's own feed history, make the ring's scale outlier-proof, patch the SVG in place (enabling a subtle arc transition), expose the state to assistive tech, and give the overdue "now" state an honest tap caption.

**Architecture:** The kernel and ring live in `src/app.html`'s single inline ES5 script (no build step, no modules). Tests reach it by slicing named top-level functions out of the file with a brace-counting extractor (`test/app-inline.ts`) and rebuilding them in a `new Function` sandbox with the few DOM/settings-coupled dependencies injected. Pure-math tests run in vitest's default node env; DOM-behavior tests run under a per-file jsdom environment. Model changes (t½ grid calibration, p90 peak) reuse the existing memoize-on-array-identity pattern (`medFeedMl` is the template).

**Tech Stack:** Vitest 4 (node env default, `// @vitest-environment jsdom` per file), jsdom (new devDependency), plain ES5 inside `src/app.html`, TypeScript for tests only. Note: `tsconfig.json` includes only `src/**/*.ts` — test files are NOT typechecked by `npm run typecheck`; vitest transpiles them itself.

---

## Context

The belly ring replaced the bottle tank on 2026-07-13: one shared volume-scaled truncated power-exponential gastric-emptying kernel drives fullness, the digested gauge, and a corner radial ring whose centre shows a countdown to the next feed. Post-ship review found six hardening items:

1. The kernel math is verified only by throwaway scratch scripts — no repo tests (a real float-boundary bug was caught during development; nothing guards against its return).
2. `peak` (the ring's 0→full scale) is the all-time **max** of feed-instant fullness — one typo'd mega-feed (amounts up to 5000 ml are accepted) compresses every future arc.
3. The emptying half-life is a hardcoded 60-min constant (`FG_T_HALF_MS`). The hungry *classification* self-corrects (the same kernel measures both current fullness and the pre-feed references), but the countdown's *slope* does not — breastmilk vs formula alone is ~2× in gastric emptying.
4. `updateBellyTank` rebuilds via `innerHTML`, destroying node identity — the arc can never transition; it jumps on every scrub/tick.
5. The SVG is `aria-hidden` and the container has no `aria-label` — screen readers get a bare "~40m" with zero context.
6. Once the hunger crossing passes, the token reads "now" indefinitely (a long nap can sit red for hours) with no way to judge how overdue.

### Reusable verification commands

Inline-script syntax check (run after every `src/app.html` edit):

```bash
node -e 'const fs=require("fs");const m=[...fs.readFileSync("src/app.html","utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).sort((a,b)=>b.length-a.length)[0];new Function(m);console.log("inline script SYNTAX OK")'
```

Expected: `inline script SYNTAX OK`

Full suite: `npm test` (126 tests pass before this plan; the count grows each task). Typecheck: `npm run typecheck` (src only).

### Line-number caveat

Line numbers below are correct at plan-writing time (commit after "drop the ≈ from the ring's ml token"). Earlier tasks shift later numbers — always locate code by the quoted content, not the number.

---

## File Structure

- **Create** `test/app-inline.ts` — extractor (`fnSource`, `varLines`) + sandbox builders (`kernel()` in Task 1, `ring()` in Task 4). Helper only; not a test suite itself (doesn't match `*.test.ts`).
- **Create** `test/belly-kernel.test.ts` — kernel characterization (Task 1) + peak robustness (Task 2).
- **Create** `test/belly-calib.test.ts` — t½ self-calibration (Task 3).
- **Create** `test/belly-ring.dom.test.ts` — jsdom UI tests: in-place patching (Task 4), aria-label (Task 5), overdue tip (Task 6).
- **Modify** `src/app.html` — kernel block (~3878–3959), `hungerCalib` (~3974–4011), new calibration block after it, ring block (~4232–4345), CSS (~1333–1359), es i18n dict (~1708–1717).
- **Modify** `package.json` — add `jsdom` devDependency (Task 4).

---

## Task 0: Branch + commit the pending token change

The working tree has one uncommitted edit on `main` (`src/app.html`: the ring's ml fallback token dropped its `≈` prefix). Never work on main.

**Files:**
- Modify: none (branch + commit only)

- [ ] **Step 1: Create the work branch**

```bash
cd /home/gllera/ws/babylog
git checkout -b work/2026-07-13-ring-hardening
```

- [ ] **Step 2: Verify the pending diff is only the token change**

```bash
git diff
```

Expected: a single hunk in `src/app.html` — `return "≈" + fgMl(ml) + '<i class="br-ml">ml</i>';` → `return fgMl(ml) + '<i class="br-ml">ml</i>';`. If anything else shows up, STOP and ask.

- [ ] **Step 3: Commit it, plus this plan**

```bash
git add src/app.html docs/superpowers/plans/2026-07-13-belly-ring-hardening.md
git commit -m "style(web): drop the ≈ from the ring's ml token; add hardening plan"
```

- [ ] **Step 4: Confirm clean tree**

```bash
git status --short
```

Expected: empty (untracked docs from other work may remain; that's fine).

---

## Task 1: Extract the inline kernel and lock its math under vitest

The inline script exports nothing. Build a brace-counting extractor and a characterization suite that pins the kernel's contract: exact boundaries, the design's spans, conservation, sublinear scaling, median memoization. These tests pass immediately (they lock current behavior — that's the point); the TDD red phase comes in Tasks 2–6 which extend this scaffolding.

**Files:**
- Create: `test/app-inline.ts`
- Create: `test/belly-kernel.test.ts`

- [ ] **Step 1: Write the extractor helper**

Create `test/app-inline.ts` with exactly:

```ts
// Reach into src/app.html's single inline ES5 script. The belly kernel/ring
// code has no build step and no exports; tests slice named top-level
// functions out of the file by brace counting and rebuild them inside a
// `new Function` sandbox with their few DOM/settings-coupled dependencies
// injected. Brace counting is safe here: the sliced functions' only braces
// inside string literals are balanced i18n templates like "{n}".
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../src/app.html", import.meta.url), "utf8");

/** Source of the top-level `function name(...) {...}` declaration. */
export function fnSource(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in app.html`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

/** Every top-level FG_/fg/BR_ `var` declaration line, in file order.
 *  Top-level script code in app.html is indented exactly 4 spaces;
 *  function bodies are 6+, so the anchor excludes locals. */
export function varLines(): string {
  return html
    .split("\n")
    .filter((l) => /^    var (FG_|fg[A-Z]|BR_)/.test(l))
    .join("\n");
}

/** The digestion kernel, DOM-free. `nightAt` is injected (default:
 *  everything is daytime). Fresh sandbox per call — memoization state
 *  (fgMedFor/fgMedMl etc.) never leaks between tests. */
export function kernel(nightAt: (tMs: number) => boolean = () => false): any {
  const src = [
    varLines(),
    fnSource("fgQuantile"),
    fnSource("medFeedMl"),
    fnSource("fgKappa"),
    fnSource("fgSpanMs"),
    fnSource("remFrac"),
    fnSource("digestedFrac"),
    fnSource("digSumMl"),
    fnSource("fullnessAt"),
    fnSource("hungerCalib"),
    "return { fgQuantile, medFeedMl, fgKappa, fgSpanMs, remFrac, digestedFrac," +
      " digSumMl, fullnessAt, hungerCalib, FG_T_HALF_MS, FG_BETA, FG_VOL_P," +
      " FG_EPS, FG_KAPPA0_MS, FG_TRUNC, FG_MED_FALLBACK, FG_HGR_MIN_N };",
  ].join("\n");
  return new Function("nightAt", src)(nightAt);
}
```

- [ ] **Step 2: Write the characterization suite**

Create `test/belly-kernel.test.ts` with exactly:

```ts
import { describe, it, expect } from "vitest";
import { kernel } from "./app-inline";

const H = 3600000;
const T0 = Date.UTC(2026, 6, 1);
const feed = (tMs: number, ml: number) => ({ ts: new Date(tMs).toISOString(), amount_ml: ml });

describe("belly kernel (extracted from app.html)", () => {
  it("remFrac: exactly 1 at age ≤ 0, exactly 0 at/after the span, monotone between", () => {
    const k = kernel();
    expect(k.remFrac(0, 120, 120)).toBe(1);
    expect(k.remFrac(-5 * H, 120, 120)).toBe(1);
    const span = k.fgSpanMs(120, 120);
    expect(k.remFrac(span, 120, 120)).toBe(0); // the float-boundary case that bit us in dev
    expect(k.remFrac(span + 1, 120, 120)).toBe(0);
    let prev = 1;
    for (let a = 0; a <= span; a += span / 200) {
      const v = k.remFrac(a, 120, 120);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });

  it("anchors the raw half-life at 60 min (renormalized: (0.5−ε)/(1−ε))", () => {
    const k = kernel();
    expect(k.remFrac(k.FG_T_HALF_MS, 120, 120)).toBeCloseTo((0.5 - k.FG_EPS) / (1 - k.FG_EPS), 6);
  });

  it("reproduces the design's spans: 30 ml ≈ 1.39 h, median ≈ 3.18 h, 210 ml ≈ 4.45 h", () => {
    const k = kernel();
    expect(k.fgSpanMs(30, 120) / H).toBeCloseTo(1.386, 2);
    expect(k.fgSpanMs(120, 120) / H).toBeCloseTo(3.183, 2);
    expect(k.fgSpanMs(210, 120) / H).toBeCloseTo(4.454, 2);
  });

  it("scales sublinearly: a 7× feed lasts 7^0.6 ≈ 3.21× longer, not 7×", () => {
    const k = kernel();
    expect(k.fgSpanMs(7 * 120, 120) / k.fgSpanMs(120, 120)).toBeCloseTo(Math.pow(7, k.FG_VOL_P), 6);
  });

  it("conserves: fullness + digested = fed, at any instant", () => {
    const k = kernel();
    const feeds = [feed(T0, 100), feed(T0 + 2 * H, 140), feed(T0 + 3.5 * H, 60), feed(T0 + 7 * H, 90), feed(T0 + 9 * H, 120)];
    for (const t of [T0 + 1 * H, T0 + 3.6 * H, T0 + 8 * H, T0 + 30 * H]) {
      const fed = feeds
        .filter((f) => new Date(f.ts).getTime() <= t)
        .reduce((s, f) => s + f.amount_ml, 0);
      expect(k.fullnessAt(feeds, t) + k.digSumMl(feeds, T0 - 1, t)).toBeCloseTo(fed, 6);
    }
  });

  it("digSumMl is additive over adjacent windows", () => {
    const k = kernel();
    const feeds = [feed(T0, 100), feed(T0 + 2 * H, 140), feed(T0 + 5 * H, 80), feed(T0 + 6 * H, 90), feed(T0 + 8 * H, 110)];
    const [a, b, c] = [T0 + 1 * H, T0 + 4 * H, T0 + 9 * H];
    expect(k.digSumMl(feeds, a, b) + k.digSumMl(feeds, b, c)).toBeCloseTo(k.digSumMl(feeds, a, c), 6);
  });

  it("medFeedMl: median of non-zero amounts, 120 fallback under 5 samples, memoized on identity", () => {
    const k = kernel();
    expect(k.medFeedMl([feed(T0, 100), feed(T0 + H, 200)])).toBe(k.FG_MED_FALLBACK);
    const feeds = [50, 100, 150, 200, 250].map((ml, i) => feed(T0 + i * H, ml));
    feeds.push(feed(T0 + 9 * H, 0)); // zero amounts don't count
    expect(k.medFeedMl(feeds)).toBe(150);
    feeds.push(feed(T0 + 10 * H, 5000)); // same identity → memo answers, no recompute
    expect(k.medFeedMl(feeds)).toBe(150);
  });

  it("hungerCalib: null under 20 samples; day/night refs with combined fallback", () => {
    const k = kernel();
    const few = Array.from({ length: 19 }, (_, i) => feed(T0 + i * 3 * H, 100));
    expect(k.hungerCalib(few)).toBeNull();
    const many = Array.from({ length: 24 }, (_, i) => feed(T0 + i * 3 * H, 100));
    const refs = k.hungerCalib(many);
    expect(refs.n).toBe(24);
    expect(refs.firstMs).toBe(T0);
    expect(refs.day).toBeGreaterThan(0);
    expect(refs.night).toBe(refs.day); // stubbed nightAt=false → no night samples → combined median
    expect(refs.peak).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 3: Run the new suite**

Run: `npx vitest run test/belly-kernel.test.ts`
Expected: 8 tests PASS (characterization — locking current behavior, not TDD-red).

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: 134 tests pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add test/app-inline.ts test/belly-kernel.test.ts
git commit -m "test(web): extract the inline belly kernel and lock its math under vitest"
```

---

## Task 2: Ring scale survives a typo'd mega-feed (p90 peak, not max)

`hungerCalib` returns `peak` = the running **max** of feed-instant fullness maxima. Feed amounts up to 5000 ml are accepted (see `MAX_FEEDING_ML`), so one fat-fingered entry permanently compresses every future arc. Switch to the p90 of the maxima; `frac` already clamps at 1 (src/app.html:4292), so genuinely-fuller-than-p90 instants simply read full.

**Files:**
- Modify: `src/app.html` (`hungerCalib`, ~lines 3987–4010)
- Test: `test/belly-kernel.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("belly kernel …")` block in `test/belly-kernel.test.ts`:

```ts
  it("peak survives a typo'd mega-feed (p90 of feed-instant maxima, not the max)", () => {
    const k = kernel();
    // 39 honest 100 ml feeds every 3 h + one 900 ml typo in the middle.
    const feeds = Array.from({ length: 39 }, (_, i) => feed(T0 + i * 3 * H, 100));
    feeds.push(feed(T0 + 19.5 * 3 * H, 900));
    const refs = k.hungerCalib(feeds);
    expect(refs.peak).toBeGreaterThan(100);
    expect(refs.peak).toBeLessThan(500); // the max would be ≈ 930
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/belly-kernel.test.ts`
Expected: FAIL — `refs.peak` ≈ 927+ (the max), assertion `toBeLessThan(500)` trips.

- [ ] **Step 3: Implement p90 in hungerCalib**

In `src/app.html`, `hungerCalib` currently reads (excerpt, ~3987–4010):

```js
      var all = [], day = [], night = [], peak = 0;
      for (i = 0; i < ev.length; i++) {
        f = 0;
        for (j = i - 1; j >= 0 && ev[i].t - ev[j].t < span; j--)
          f += ev[j].a * remFrac(ev[i].t - ev[j].t, ev[j].a, m);
        all.push(f);
        // Fullness maxima only occur at feed instants (it decays between),
        // so this is the history's fullness ceiling — a scrub-stable scale
        // for the trace.
        if (f + ev[i].a > peak) peak = f + ev[i].a;
        (nightAt(ev[i].t) ? night : day).push(f);
      }
```

Replace with:

```js
      var all = [], day = [], night = [], peaks = [];
      for (i = 0; i < ev.length; i++) {
        f = 0;
        for (j = i - 1; j >= 0 && ev[i].t - ev[j].t < span; j--)
          f += ev[j].a * remFrac(ev[i].t - ev[j].t, ev[j].a, m);
        all.push(f);
        // Fullness maxima only occur at feed instants (it decays between).
        // The ring's scale is the p90 of those maxima, NOT the max — one
        // typo'd mega-feed must not compress every future arc (frac clamps
        // at 1, so the genuinely-fuller top decile simply reads full).
        peaks.push(f + ev[i].a);
        (nightAt(ev[i].t) ? night : day).push(f);
      }
```

And where the return object is built (~4000–4010), currently:

```js
      all.sort(function(a, b) { return a - b; });
      day.sort(function(a, b) { return a - b; });
      night.sort(function(a, b) { return a - b; });
      var med = fgQuantile(all, 0.5);
      return {
        day: day.length >= FG_HGR_MIN_CLASS ? fgQuantile(day, 0.5) : med,
        night: night.length >= FG_HGR_MIN_CLASS ? fgQuantile(night, 0.5) : med,
        n: all.length,
        firstMs: ev[0].t,
        peak: peak
      };
```

Replace the two `peak` touchpoints (add one sort line, change the returned field):

```js
      all.sort(function(a, b) { return a - b; });
      day.sort(function(a, b) { return a - b; });
      night.sort(function(a, b) { return a - b; });
      peaks.sort(function(a, b) { return a - b; });
      var med = fgQuantile(all, 0.5);
      return {
        day: day.length >= FG_HGR_MIN_CLASS ? fgQuantile(day, 0.5) : med,
        night: night.length >= FG_HGR_MIN_CLASS ? fgQuantile(night, 0.5) : med,
        n: all.length,
        firstMs: ev[0].t,
        peak: fgQuantile(peaks, 0.9)
      };
```

- [ ] **Step 4: Run tests + syntax check**

Run: `npx vitest run test/belly-kernel.test.ts` — expected: 9 tests PASS.
Run the inline-script syntax check (see Context) — expected: `SYNTAX OK`.

- [ ] **Step 5: Commit**

```bash
git add src/app.html test/belly-kernel.test.ts
git commit -m "fix(web): ring scale is the p90 of feed-instant maxima, not the max"
```

---

## Task 3: Self-calibrated emptying half-life

t½ is a per-baby unknown. Pick it from her own history: for each candidate half-life on a coarse grid, re-derive the pre-feed reference levels under that candidate's kernel (they must move together), forecast the next feed after each historical feed, and score by the median |forecast − actual|. The prior (60 min) is evaluated first and later candidates must strictly beat it — regular schedules are forecast-invariant across candidates (steady state), so noise never dislodges the prior without signal. Memoized on the feeds array identity like `medFeedMl`; sparse history (< 20 feeds, the meter's own gate) keeps the anchor.

**Files:**
- Modify: `src/app.html` (`fgKappa` ~3916, `remFrac` ~3923, `digSumMl` ~3937, `fullnessAt` ~3952, new block after `hungerCalib` ~4011, comment at ~3885)
- Modify: `test/app-inline.ts` (extend `kernel()`)
- Create: `test/belly-calib.test.ts`

- [ ] **Step 1: Extend `kernel()` for the new functions**

In `test/app-inline.ts`, in `kernel()`'s `src` array, insert after the `fnSource("hungerCalib"),` line:

```ts
    fnSource("calibKappa0"),
    fnSource("fgForecastErr"),
```

and extend the return statement string to also export them — replace the existing return line with:

```ts
    "return { fgQuantile, medFeedMl, fgKappa, fgSpanMs, remFrac, digestedFrac," +
      " digSumMl, fullnessAt, hungerCalib, calibKappa0, fgForecastErr," +
      " FG_T_HALF_MS, FG_BETA, FG_VOL_P, FG_EPS, FG_KAPPA0_MS, FG_TRUNC," +
      " FG_MED_FALLBACK, FG_HGR_MIN_N };",
```

- [ ] **Step 2: Write the failing test**

Create `test/belly-calib.test.ts` with exactly:

```ts
import { describe, it, expect } from "vitest";
import { kernel } from "./app-inline";

const T0 = Date.UTC(2026, 5, 1);

// Simulate a baby whose TRUE emptying half-life is tHalfMin: alternating
// feed sizes, each next feed placed (1-min steps) exactly when fullness
// under the true kernel crosses refMl. Size variation is what breaks the
// steady-state invariance and lets the backtest discriminate — with equal
// feeds at equal gaps, every candidate forecasts the same crossing.
function makeBaby(k: any, tHalfMin: number, sizes: number[], nFeeds: number, refMl: number) {
  const k0 = (tHalfMin * 60000) / Math.pow(Math.LN2, 1 / k.FG_BETA);
  const medMl = 120; // median of the alternating sizes below — keep sizes symmetric around it
  const feeds: { ts: string; amount_ml: number }[] = [];
  const ev: { t: number; a: number }[] = [];
  let t = T0;
  for (let i = 0; i < nFeeds; i++) {
    const a = sizes[i % sizes.length];
    feeds.push({ ts: new Date(t).toISOString(), amount_ml: a });
    ev.push({ t, a });
    let tau = t + 60000;
    for (;;) {
      let f = 0;
      for (const e of ev) if (e.t <= tau) f += e.a * k.remFrac(tau - e.t, e.a, medMl, k0);
      if (f < refMl || tau - t > 12 * 3600000) break;
      tau += 60000;
    }
    t = tau;
  }
  return feeds;
}

const tHalfMin = (k: any, k0: number) => (k0 * Math.pow(Math.LN2, 1 / k.FG_BETA)) / 60000;

describe("calibKappa0 (self-calibrated emptying half-life)", () => {
  it("recovers a fast emptier vs a slow one", () => {
    const k = kernel();
    const fast = makeBaby(k, 45, [60, 180], 40, 15);
    const tFast = tHalfMin(k, k.calibKappa0(fast));
    const k2 = kernel(); // fresh sandbox — no memo/k0 state bleed
    const slow = makeBaby(k2, 120, [60, 180], 40, 15);
    const tSlow = tHalfMin(k2, k2.calibKappa0(slow));
    expect(tFast).toBeLessThanOrEqual(60);
    expect(tSlow).toBeGreaterThanOrEqual(90);
    expect(tFast).toBeLessThan(tSlow);
  });

  it("keeps the 60-min anchor when history is sparse", () => {
    const k = kernel();
    const few = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(T0 + i * 3 * 3600000).toISOString(),
      amount_ml: 100,
    }));
    expect(k.calibKappa0(few)).toBe(k.FG_KAPPA0_MS);
  });

  it("memoizes on the feeds array identity", () => {
    const k = kernel();
    const feeds = makeBaby(k, 45, [60, 180], 40, 15);
    expect(k.calibKappa0(feeds)).toBe(k.calibKappa0(feeds));
  });
});
```

Note (contingency, do NOT weaken assertions): if the fast/slow test discriminates too weakly with `[60, 180]`, raise the size contrast to `[40, 200]` and `nFeeds` to 60 — more contrast, more signal.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/belly-calib.test.ts test/belly-kernel.test.ts`
Expected: BOTH files FAIL — `Error: function calibKappa0 not found in app.html`. Step 1 added the extraction to the shared `kernel()`, so the Task 1/2 suite is red too until the implementation lands; both go green in Step 5.

- [ ] **Step 4: Implement in app.html — plumb an explicit κ₀ through the kernel**

4a. Update the comment on the anchor constant (~3885). Currently:

```js
    var FG_T_HALF_MS = 60 * 60 * 1000; // a median feed half-empties at 60 min
```

Replace with:

```js
    var FG_T_HALF_MS = 60 * 60 * 1000; // prior anchor: a median feed half-empties at 60 min (calibKappa0 may re-pick t½ from her own history)
```

4b. `fgKappa` (~3916). Currently:

```js
    function fgKappa(amountMl, medMl) {
      return FG_KAPPA0_MS * Math.pow((amountMl > 0 ? amountMl : medMl) / medMl, FG_VOL_P);
    }
```

Replace with:

```js
    function fgKappa(amountMl, medMl, k0) {
      return (k0 || fgK0Ms) * Math.pow((amountMl > 0 ? amountMl : medMl) / medMl, FG_VOL_P);
    }
```

4c. `remFrac` (~3923). Currently:

```js
    function remFrac(ageMs, amountMl, medMl) {
      if (ageMs <= 0) return 1;
      var kappa = fgKappa(amountMl, medMl);
```

Replace those lines with (rest of the body unchanged):

```js
    function remFrac(ageMs, amountMl, medMl, k0) {
      if (ageMs <= 0) return 1;
      var kappa = fgKappa(amountMl, medMl, k0);
```

4d. Hook the calibration into the three live kernel consumers, so κ₀ is settled before any fullness math on a new payload:

`digSumMl` (~3937) — currently starts:

```js
    function digSumMl(feeds, startMs, endMs) {
      var m = medFeedMl(feeds), s = 0, i, t, a;
```

Replace with:

```js
    function digSumMl(feeds, startMs, endMs) {
      calibKappa0(feeds);
      var m = medFeedMl(feeds), s = 0, i, t, a;
```

`fullnessAt` (~3952) — currently starts:

```js
    function fullnessAt(feeds, tMs) {
      var m = medFeedMl(feeds), s = 0, i, t, a;
```

Replace with:

```js
    function fullnessAt(feeds, tMs) {
      calibKappa0(feeds);
      var m = medFeedMl(feeds), s = 0, i, t, a;
```

`hungerCalib` (~3974) — currently starts:

```js
    function hungerCalib(feeds) {
      var m = medFeedMl(feeds);
```

Replace with:

```js
    function hungerCalib(feeds) {
      calibKappa0(feeds);
      var m = medFeedMl(feeds);
```

4e. Add the calibration block immediately AFTER the closing `}` of `hungerCalib` (~4011):

```js
    // ---- Self-calibrated emptying speed (see the realistic belly-ring design in docs/) ----
    // t½ is a per-baby unknown (breastmilk vs formula alone is ~2×). The
    // hungry classification self-corrects — the same kernel measures both
    // the current fullness and the pre-feed references — but the countdown's
    // *slope* does not. So pick the half-life whose own next-feed forecast
    // best matches when she actually got fed. The grid is ordered prior-first
    // (by distance from the 60-min anchor) with strict improvement required,
    // so regular schedules — forecast-invariant across candidates — keep the
    // prior. Memoized on the feeds array identity like medFeedMl; sparse
    // history (under the meter's own 20-sample gate) keeps the anchor.
    var FG_T_HALF_GRID = [60, 45, 75, 30, 90, 105, 120]; // minutes, prior-first
    var fgK0For = null, fgK0Ms = FG_KAPPA0_MS;
    function calibKappa0(feeds) {
      if (feeds === fgK0For) return fgK0Ms;
      fgK0For = feeds;
      fgK0Ms = FG_KAPPA0_MS;
      var m = medFeedMl(feeds), ev = [], i;
      for (i = 0; i < feeds.length; i++)
        ev.push({ t: new Date(feeds[i].ts).getTime(), a: feeds[i].amount_ml || 0 });
      ev.sort(function(a, b) { return a.t - b.t; });
      if (ev.length < FG_HGR_MIN_N) return fgK0Ms;
      var bestErr = Infinity;
      for (i = 0; i < FG_T_HALF_GRID.length; i++) {
        var k0 = FG_T_HALF_GRID[i] * 60000 / Math.pow(Math.LN2, 1 / FG_BETA);
        var err = fgForecastErr(ev, m, k0);
        if (err != null && err < bestErr) { bestErr = err; fgK0Ms = k0; }
      }
      return fgK0Ms;
    }

    // Median |forecast − actual| (ms) for the candidate kernel: derive the
    // candidate's own pre-feed reference levels, then after each feed
    // forecast the reference crossing (5-min steps, 12h bound — a miss
    // scores the bound, so a kernel that never predicts is penalized, not
    // skipped) and compare against the next real feed. One grid evaluation
    // is O(n·(span + 144·span)) — ms-scale for a loaded strip, and the
    // whole grid runs once per payload thanks to the memo above.
    function fgForecastErr(ev, m, k0) {
      var pre = [], day = [], night = [], i, j, t, f;
      var maxA = 0;
      for (i = 0; i < ev.length; i++) if (ev[i].a > maxA) maxA = ev[i].a;
      var span = fgKappa(maxA, m, k0) * FG_TRUNC;
      for (i = 0; i < ev.length; i++) {
        f = 0;
        for (j = i - 1; j >= 0 && ev[i].t - ev[j].t < span; j--)
          f += ev[j].a * remFrac(ev[i].t - ev[j].t, ev[j].a, m, k0);
        pre.push(f);
        (nightAt(ev[i].t) ? night : day).push(f);
      }
      var all = pre.slice().sort(function(a, b) { return a - b; });
      day.sort(function(a, b) { return a - b; });
      night.sort(function(a, b) { return a - b; });
      var med = fgQuantile(all, 0.5);
      var refDay = day.length >= FG_HGR_MIN_CLASS ? fgQuantile(day, 0.5) : med;
      var refNight = night.length >= FG_HGR_MIN_CLASS ? fgQuantile(night, 0.5) : med;
      var errs = [];
      for (i = 0; i < ev.length - 1; i++) {
        var cross = null;
        for (var k = 0; k <= 144; k++) { // 12h in 5-min steps
          t = ev[i].t + k * 300000;
          f = 0;
          for (j = i; j >= 0 && t - ev[j].t < span; j--)
            f += ev[j].a * remFrac(t - ev[j].t, ev[j].a, m, k0);
          if (f < (nightAt(t) ? refNight : refDay)) { cross = t; break; }
        }
        errs.push(Math.abs((cross == null ? ev[i].t + 144 * 300000 : cross) - ev[i + 1].t));
      }
      if (!errs.length) return null;
      errs.sort(function(a, b) { return a - b; });
      return fgQuantile(errs, 0.5);
    }
```

Design notes for the implementer:
- `calibKappa0` → `medFeedMl` and `fgForecastErr` → `remFrac(…, k0)` only — no call path re-enters `calibKappa0`, so the consumer hooks can't recurse.
- `fgForecastErr` inlines its fullness sums instead of calling `fullnessAt` precisely to avoid the hook.
- `fgSpanMs` stays 2-arg: its live callers run after `calibKappa0`, so the implicit `fgK0Ms` is already the calibrated one.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/belly-calib.test.ts test/belly-kernel.test.ts`
Expected: all PASS (Task 1/2 tests too — their sparse fixtures keep the anchor; the calibrated ones only need order-stable properties). If the fast/slow test fails, apply the contingency in Step 2.

- [ ] **Step 6: Syntax check + full suite**

Run the inline-script syntax check — expected `SYNTAX OK`. Then `npm test` — expected: all pass (126 pre-plan + 9 kernel + 3 calib = 138).

- [ ] **Step 7: Commit**

```bash
git add src/app.html test/app-inline.ts test/belly-calib.test.ts
git commit -m "feat(web): self-calibrated emptying half-life — grid-picked by backtesting the kernel's own next-feed forecast"
```

---

## Task 4: Patch the ring SVG in place (node identity → CSS transition)

`updateBellyTank` rebuilds via `innerHTML` on every change, so the arc jumps. Build the structure once, then patch attributes on the live nodes; add a subtle `stroke-dasharray` transition with a reduced-motion guard. Tests need a DOM → add jsdom (per-file environment; the rest of the suite stays node).

**Files:**
- Modify: `package.json` (jsdom devDependency)
- Modify: `test/app-inline.ts` (add `ring()`)
- Create: `test/belly-ring.dom.test.ts`
- Modify: `src/app.html` (`updateBellyTank` ~4274–4320, CSS `.br-fill` ~1336)

- [ ] **Step 1: Install jsdom**

```bash
npm install -D jsdom
```

Expected: `package.json` gains `"jsdom"` under devDependencies; lockfile updates.

- [ ] **Step 2: Add the `ring()` sandbox builder**

Append to `test/app-inline.ts`:

```ts
/** The ring renderer + tap tip, run against a real DOM (jsdom) with
 *  injected app-state stubs. Pass a `Date` whose static `now()` is pinned. */
export function ring(stubs: Record<string, any>): any {
  const deps = [
    "document", "Date", "dashboardData", "hungerRefs", "markerInstant",
    "nightAt", "stripMarkerMin", "rsNowMin", "i18n", "formatTimeOfDay",
    "tapTipEl", "hideTapTip",
  ];
  const src = [
    varLines(),
    "var bellyTankLast = null;",
    fnSource("fgQuantile"),
    fnSource("fgMl"),
    fnSource("medFeedMl"),
    fnSource("fgKappa"),
    fnSource("fgSpanMs"),
    fnSource("remFrac"),
    fnSource("fullnessAt"),
    fnSource("calibKappa0"),
    fnSource("fgForecastErr"),
    fnSource("hungerCrossMs"),
    fnSource("bellyCountdownToken"),
    fnSource("updateBellyTank"),
    fnSource("bellyTankTip"),
    "return { updateBellyTank, bellyTankTip, bellyCountdownToken };",
  ].join("\n");
  return new Function(...deps, src)(...deps.map((d) => stubs[d]));
}
```

- [ ] **Step 3: Write the failing DOM test**

Create `test/belly-ring.dom.test.ts` with exactly:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { ring } from "./app-inline";

const NOW = Date.UTC(2026, 6, 13, 10, 0);
class FakeDate extends Date {
  static now() { return NOW; }
}
const feed = (minAgo: number, ml: number) => ({
  ts: new Date(NOW - minAgo * 60000).toISOString(),
  amount_ml: ml,
});
// 5 non-zero feeds → medFeedMl uses the real median; < 20 → calibration keeps the anchor.
const FEEDS = [feed(30, 100), feed(200, 120), feed(400, 110), feed(600, 90), feed(800, 100)];

function setup(opts: { feeds?: any[]; gated?: boolean; atNow?: boolean; refs?: any } = {}) {
  document.body.innerHTML = '<div id="belly-tank" hidden></div>';
  const refs = opts.gated ? null : { day: 20, night: 10, peak: 200, firstMs: 0, n: 30, ...opts.refs };
  let markerMs = NOW;
  const r = ring({
    document,
    Date: FakeDate,
    dashboardData: { strip_feedings: opts.feeds ?? FEEDS },
    hungerRefs: () => refs,
    markerInstant: () => new FakeDate(markerMs),
    nightAt: () => false,
    stripMarkerMin: () => (opts.atNow === false ? 0 : 1),
    rsNowMin: () => 1,
    i18n: (s: string, v?: any) => (v ? s.replace(/\{(\w+)\}/g, (_m: any, k: string) => v[k]) : s),
    formatTimeOfDay: (d: Date) => d.toISOString().slice(11, 16),
    tapTipEl: null,
    hideTapTip: () => {},
  });
  return {
    r,
    el: document.getElementById("belly-tank")!,
    setMarker: (m: number) => { markerMs = m; },
  };
}

describe("belly ring DOM", () => {
  it("builds the ring once: track, fill (rotated to 12 o'clock), tick, token", () => {
    const { r, el } = setup();
    r.updateBellyTank();
    expect(el.hidden).toBe(false);
    expect(el.querySelector(".br-track")).toBeTruthy();
    expect(el.querySelector(".br-fill")!.getAttribute("transform")).toBe("rotate(-90 24 24)");
    expect(el.querySelector(".br-tick")).toBeTruthy();
    expect(el.querySelector(".br-token")!.textContent).not.toBe("");
  });

  it("stays hidden when gated off", () => {
    const { r, el } = setup({ gated: true });
    r.updateBellyTank();
    expect(el.hidden).toBe(true);
  });

  it("patches the ring in place across updates (node identity preserved)", () => {
    const { r, el, setMarker } = setup();
    r.updateBellyTank();
    const fill = el.querySelector(".br-fill")!;
    const before = fill.getAttribute("stroke-dasharray");
    setMarker(NOW + 90 * 60000); // scrub 90 min forward — the arc must shrink
    r.updateBellyTank();
    expect(el.querySelector(".br-fill")).toBe(fill); // same node, not an innerHTML rebuild
    expect(fill.getAttribute("stroke-dasharray")).not.toBe(before);
  });

  it("toggles hungry when fullness drops under the reference", () => {
    const { r, el, setMarker } = setup();
    r.updateBellyTank();
    expect(el.classList.contains("hungry")).toBe(false);
    setMarker(NOW + 90 * 60000); // last feed now 2 h old → ≈13.5 ml < day ref 20
    r.updateBellyTank();
    expect(el.classList.contains("hungry")).toBe(true);
  });
});
```

- [ ] **Step 4: Run test to verify the patching case fails**

Run: `npx vitest run test/belly-ring.dom.test.ts`
Expected: "patches the ring in place" FAILS (`.br-fill` is a different node after the rebuild); the build-once, gating, and hungry tests PASS (current behavior).

- [ ] **Step 5: Rewrite updateBellyTank to patch in place**

In `src/app.html`, replace the ENTIRE current block (from `var bellyTankLast = null;` through the closing `}` of `updateBellyTank`, ~4273–4320) with:

```js
    var bellyTankLast = null; // last rendered-state signature (no-op detector)
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
      // Arc length = fullness on the 0→peak scale, with a sliver floor so a
      // non-empty belly never reads fully empty; the reserve tick sits on the
      // same scale. Both clamp to a full sweep at the fringe past peak.
      var frac = Math.max(0, Math.min(1, f / refs.peak));
      if (f > 0 && frac < BR_FLOOR) frac = BR_FLOOR;
      var refFrac = Math.max(0, Math.min(1, ref / refs.peak));
      var circ = 2 * Math.PI * BR_R;
      // Reserve tick: a short radial segment across the ring at the reference
      // angle (0 at 12 o'clock, clockwise), from just inside to just outside.
      var th = 2 * Math.PI * refFrac, s = Math.sin(th), c = Math.cos(th);
      var token = bellyCountdownToken(feeds, refs, f);
      el.classList.toggle("hungry", f < ref);
      el.hidden = false;
      // The svg is built once and then patched in place — node identity is
      // what lets the arc's CSS transition run (an innerHTML rebuild remakes
      // the nodes and jumps). The signature spares quiet ticks a patch; a
      // changed one invalidates an open caption (its estimate went stale).
      var sig = frac.toFixed(4) + "|" + refFrac.toFixed(4) + "|" + token + "|" + (f < ref);
      if (sig === bellyTankLast && el.firstChild) return;
      bellyTankLast = sig;
      if (tapTipEl && tapTipEl.tipFor === el) hideTapTip();
      if (!el.firstChild) {
        el.innerHTML = '<span class="br-wrap">' +
          '<svg class="br-svg" width="' + BR_SZ + '" height="' + BR_SZ + '" viewBox="0 0 ' + BR_SZ + ' ' + BR_SZ + '" aria-hidden="true">' +
            '<circle class="br-track" cx="' + BR_C + '" cy="' + BR_C + '" r="' + BR_R + '"/>' +
            '<circle class="br-fill" cx="' + BR_C + '" cy="' + BR_C + '" r="' + BR_R +
              '" transform="rotate(-90 ' + BR_C + ' ' + BR_C + ')"/>' +
            '<line class="br-tick"/>' +
          '</svg>' +
          '<span class="br-token"></span></span>';
      }
      el.querySelector(".br-fill").setAttribute("stroke-dasharray",
        (circ * frac).toFixed(2) + " " + circ.toFixed(2));
      var tick = el.querySelector(".br-tick");
      tick.setAttribute("x1", (BR_C + (BR_R - BR_TICK) * s).toFixed(2));
      tick.setAttribute("y1", (BR_C - (BR_R - BR_TICK) * c).toFixed(2));
      tick.setAttribute("x2", (BR_C + (BR_R + BR_TICK) * s).toFixed(2));
      tick.setAttribute("y2", (BR_C - (BR_R + BR_TICK) * c).toFixed(2));
      el.querySelector(".br-token").innerHTML = token;
    }
```

- [ ] **Step 6: Add the transition CSS**

In `src/app.html` (~1336), currently:

```css
    .br-fill { fill: none; stroke: var(--primary); stroke-width: 4; }
```

Replace with:

```css
    /* Patched in place (node identity survives updates), so the arc can
       ease between states instead of jumping on scrubs and ticks. */
    .br-fill { fill: none; stroke: var(--primary); stroke-width: 4; transition: stroke-dasharray 240ms ease; }
    @media (prefers-reduced-motion: reduce) { .br-fill { transition: none; } }
```

- [ ] **Step 7: Run tests + syntax check**

Run: `npx vitest run test/belly-ring.dom.test.ts` — expected: 4 tests PASS.
Run the inline-script syntax check — expected `SYNTAX OK`.
Run `npm test` — expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json test/app-inline.ts test/belly-ring.dom.test.ts src/app.html
git commit -m "refactor(web): belly ring patches its svg in place — node identity enables a reduced-motion-aware arc transition"
```

---

## Task 5: aria-label on the ring

The SVG is decorative (`aria-hidden`), which leaves assistive tech with a bare token like "~40m". Label the container with the belly ml, plus the countdown when one is showing (the ml-fallback token would just repeat the label).

**Files:**
- Modify: `src/app.html` (end of `updateBellyTank`)
- Test: `test/belly-ring.dom.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe("belly ring DOM")` block in `test/belly-ring.dom.test.ts`:

```ts
  it("labels the ring for assistive tech: belly ml, countdown riding along", () => {
    const { r, el } = setup();
    r.updateBellyTank();
    // ≈76 ml in the belly, crossing ≈74 min out → token "~1h"
    expect(el.getAttribute("aria-label")).toMatch(/^belly ≈ \d+ ml · /);
  });

  it("does not repeat the ml when the token IS the ml fallback", () => {
    const { r, el } = setup({ atNow: false }); // marker in the past → no countdown
    r.updateBellyTank();
    expect(el.getAttribute("aria-label")).toMatch(/^belly ≈ \d+ ml$/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/belly-ring.dom.test.ts`
Expected: both new tests FAIL (`aria-label` is null).

- [ ] **Step 3: Implement**

In `src/app.html`, at the very end of `updateBellyTank`, directly after the line:

```js
      el.querySelector(".br-token").innerHTML = token;
```

add:

```js
      // The svg is decorative (aria-hidden); the div itself tells assistive
      // tech the story — belly ml, plus the countdown when one is showing
      // (the ml-fallback token would just repeat the label).
      var label = i18n("belly ≈ {n} ml", { n: fgMl(f) });
      if (token.indexOf("br-ml") < 0) label += " · " + token;
      el.setAttribute("aria-label", label);
```

- [ ] **Step 4: Run tests + syntax check**

Run: `npx vitest run test/belly-ring.dom.test.ts` — expected: 6 tests PASS.
Run the inline-script syntax check — expected `SYNTAX OK`.

- [ ] **Step 5: Commit**

```bash
git add src/app.html test/belly-ring.dom.test.ts
git commit -m "feat(web): belly ring carries an aria-label — belly ml plus the live countdown"
```

---

## Task 6: The overdue tip says when she'd usually have been fed

Once the crossing passes, the centre token reads "now" indefinitely — technically honest, but after a long nap it reads naggy with no way to judge. Keep the token; make the TAP caption carry the crossing's clock time ("usually fed by ~07:44") by walking backward to when fullness last sat at the reference.

**Files:**
- Modify: `src/app.html` (new `hungerCrossPastMs` after `hungerCrossMs` ~4247, `bellyTankTip` ~4329–4345, es i18n dict ~1710)
- Modify: `test/app-inline.ts` (add the new function to `ring()`)
- Test: `test/belly-ring.dom.test.ts`

- [ ] **Step 1: Extend `ring()`**

In `test/app-inline.ts`, in `ring()`'s `src` array, insert after `fnSource("hungerCrossMs"),`:

```ts
    fnSource("hungerCrossPastMs"),
```

- [ ] **Step 2: Write the failing tests**

Append inside the `describe("belly ring DOM")` block in `test/belly-ring.dom.test.ts`:

```ts
  it("tip forecasts a clock time when not yet hungry", () => {
    const { r } = setup();
    const tip = r.bellyTankTip();
    expect(tip.v).toMatch(/next feed ~\d{2}:\d{2}/);
    expect(tip.m).toContain("usually fed when");
  });

  it("tip says when she'd usually have been fed once overdue", () => {
    // Newest feed 4 h ago (past its span) → fullness 0, far under the 20 ml
    // reference; the crossing happened mid-window, ≈137 min ago.
    const overdueFeeds = [feed(240, 100), feed(600, 100), feed(900, 100), feed(1200, 100), feed(1500, 100)];
    const { r } = setup({ feeds: overdueFeeds });
    const tip = r.bellyTankTip();
    expect(tip.v).toMatch(/usually fed by ~\d{2}:\d{2}/);
    expect(tip.v).not.toContain("next feed ~ now");
  });

  it("ships the es translation for the overdue caption", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("../src/app.html", import.meta.url), "utf8");
    expect(html).toContain('"usually fed by ~{t}":');
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/belly-ring.dom.test.ts`
Expected: EVERY `ring()`-based test in the file fails with `function hungerCrossPastMs not found` (Step 1 added it to the shared `ring()` builder), and the es-translation test fails on the missing key. All go green after Step 4. (The "tip forecasts a clock time" test locks current behavior — it needs no new code beyond extraction.)

- [ ] **Step 4: Implement**

4a. In `src/app.html`, directly after the closing `}` of `hungerCrossMs` (~4247), add:

```js
    // The mirror question once already hungry: when DID she cross under the
    // reference? Walk back minute-by-minute (12h bound) to the most recent
    // instant at or above the then-current class reference; the crossing is
    // one step after it. Null when the whole window reads hungry —
    // calibration noise; better no claim than a wrong one.
    function hungerCrossPastMs(feeds, refs, nowMs) {
      for (var k = 1; k <= 720; k++) {
        var t = nowMs - k * 60000;
        if (fullnessAt(feeds, t) >= (nightAt(t) ? refs.night : refs.day)) return t + 60000;
      }
      return null;
    }
```

4b. In `bellyTankTip` (~4334–4338), currently:

```js
      if (stripMarkerMin() >= rsNowMin()) {
        var cross = hungerCrossMs(feeds, refs, Date.now());
        if (cross != null)
          v += " · " + (cross <= Date.now() ? i18n("next feed ~ now")
            : i18n("next feed ~{t}", { t: formatTimeOfDay(new Date(cross)) }));
      }
```

Replace with:

```js
      if (stripMarkerMin() >= rsNowMin()) {
        var cross = hungerCrossMs(feeds, refs, Date.now());
        if (cross != null) {
          if (cross <= Date.now()) {
            // Already under the reference: bare "now" goes stale (a long nap
            // can sit red for hours) — say when the crossing happened so the
            // parent can judge how overdue.
            var past = hungerCrossPastMs(feeds, refs, Date.now());
            v += " · " + (past != null
              ? i18n("usually fed by ~{t}", { t: formatTimeOfDay(new Date(past)) })
              : i18n("next feed ~ now"));
          } else {
            v += " · " + i18n("next feed ~{t}", { t: formatTimeOfDay(new Date(cross)) });
          }
        }
      }
```

4c. In the es i18n dict (~1710), directly after the line:

```js
        "next feed ~ now": "próxima toma ~ ya",
```

add:

```js
        "usually fed by ~{t}": "suele comer antes de las ~{t}",
```

- [ ] **Step 5: Run tests + syntax check + full suite**

Run: `npx vitest run test/belly-ring.dom.test.ts` — expected: 9 tests PASS.
Run the inline-script syntax check — expected `SYNTAX OK`.
Run `npm test` — expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/app.html test/app-inline.ts test/belly-ring.dom.test.ts
git commit -m "feat(web): overdue belly tip says when she'd usually have been fed"
```

---

## Task 7: Final verification, visual spot-check, finish the branch

**Files:** none (verification + branch finishing)

- [ ] **Step 1: Full gates**

```bash
npm run typecheck && npm test
```

Expected: tsc clean; all tests pass (126 pre-plan + 9 kernel + 3 calib + 9 DOM ≈ 147; exact count printed).

Run the inline-script syntax check once more — expected `SYNTAX OK`.

- [ ] **Step 2 (optional but recommended): visual spot-check of the ring CSS**

Build a static harness (CSS only — rendering logic is now covered by the DOM tests):

```bash
TMP=$(mktemp -d) && cat > "$TMP/h.html" <<'EOF'
<!doctype html><meta charset="utf-8">
<style>
  :root { --border:#e3e0da; --primary:#2f7dd1; --muted:#9a938a; --danger:#c0392b; --text:#221f1a; }
  body { background:#faf8f5; display:flex; gap:24px; padding:24px; }
  /*BR*/
</style>
<div id="belly-tank"><span class="br-wrap"><svg class="br-svg" width="48" height="48" viewBox="0 0 48 48"><circle class="br-track" cx="24" cy="24" r="20"/><circle class="br-fill" cx="24" cy="24" r="20" stroke-dasharray="80 125.66" transform="rotate(-90 24 24)"/><line class="br-tick" x1="40.10" y1="30.29" x2="43.44" y2="32.94"/></svg><span class="br-token">~1½h</span></span></div>
<div id="belly-tank" class="hungry"><span class="br-wrap"><svg class="br-svg" width="48" height="48" viewBox="0 0 48 48"><circle class="br-track" cx="24" cy="24" r="20"/><circle class="br-fill" cx="24" cy="24" r="20" stroke-dasharray="12 125.66" transform="rotate(-90 24 24)"/><line class="br-tick" x1="40.10" y1="30.29" x2="43.44" y2="32.94"/></svg><span class="br-token">now</span></span></div>
EOF
```

Then copy the `.br-*` CSS rules from `src/app.html` (the block from `.br-wrap {` through `#belly-tank.hungry .br-token { … }`, currently ~lines 1333–1361 — do NOT copy the `#belly-tank { position:absolute … }` rule itself) in place of the `/*BR*/` marker, and screenshot with the cached headless Chromium (see the `local-web-visual-verify` memory):

```bash
CHROME=$(ls -d ~/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome | head -1)
"$CHROME" --headless=new --no-sandbox --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=300,120 --screenshot="$TMP/ring.png" "file://$TMP/h.html"
```

Read `$TMP/ring.png` and confirm: hairline track, blue arc + dark token on the first ring; red arc + red "now" on the second; muted tick crossing both.

- [ ] **Step 3: Finish the branch**

**REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch — verify tests, then present the standard options (merge to main locally / push + PR / keep / discard) and execute the choice.
