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
