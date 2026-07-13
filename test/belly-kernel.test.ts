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

  it("peak survives a typo'd mega-feed (p90 of feed-instant maxima, not the max)", () => {
    const k = kernel();
    // 39 honest 100 ml feeds every 3 h + one 900 ml typo in the middle.
    const feeds = Array.from({ length: 39 }, (_, i) => feed(T0 + i * 3 * H, 100));
    feeds.push(feed(T0 + 19.5 * 3 * H, 900));
    const refs = k.hungerCalib(feeds);
    expect(refs.peak).toBeGreaterThan(100);
    expect(refs.peak).toBeLessThan(500); // the max would be ≈ 930
  });

  it("gates off volumeless history (peak 0) instead of handing the ring a 0 scale", () => {
    const k = kernel();
    // A breastfeeding-only household: plenty of feeds, none carrying an ml
    // amount. peak (p90 of maxima) is 0, so f/peak downstream would be NaN.
    // hungerCalib must return null so the ring gates off like young history —
    // not a refs object the renderer divides by zero.
    const volumeless = Array.from({ length: 24 }, (_, i) => feed(T0 + i * 3 * H, 0));
    expect(k.hungerCalib(volumeless)).toBeNull();
    // A history whose top decile carries volume still scales (regression guard:
    // the gate keys on peak > 0, so it must not swallow real volume — here the
    // last third of feeds carry ml, keeping the p90 of maxima positive).
    const someVolume = Array.from({ length: 24 }, (_, i) =>
      feed(T0 + i * 3 * H, i >= 16 ? 130 : 0)
    );
    const refs = k.hungerCalib(someVolume);
    expect(refs).not.toBeNull();
    expect(refs.peak).toBeGreaterThan(0);
  });
});
