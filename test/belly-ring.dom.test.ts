// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { ring, kernel } from "./app-inline";

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

  it("positions the reserve tick by a transitionable transform, not by snapping geometry", () => {
    const { r, el, setMarker } = setup();
    r.updateBellyTank();
    const tick = el.querySelector(".br-tick")!;
    // ref 20 / peak 200 = 0.1 of the ring → 36° clockwise from 12 o'clock.
    expect(tick.getAttribute("transform")).toBe("rotate(36.00 24 24)");
    // The segment itself is the fixed 12-o'clock line (x1 === x2 === centre);
    // only the transform moves, so CSS can ease it. It must NOT be repositioned
    // by snapping x1/y1/x2/y2 (transitioning geometry attrs isn't portable).
    expect(tick.getAttribute("x1")).toBe("24");
    expect(tick.getAttribute("x2")).toBe("24");
    // Node identity preserved across an update, so the transition can run.
    setMarker(NOW + 90 * 60000);
    r.updateBellyTank();
    expect(el.querySelector(".br-tick")).toBe(tick);
  });

  it("the reserve tick angle tracks the usually-fed level (refFrac)", () => {
    const a = setup({ refs: { peak: 200 } }); // refFrac 20/200 = 0.10 → 36°
    a.r.updateBellyTank();
    const angleA = a.el.querySelector(".br-tick")!.getAttribute("transform");
    const b = setup({ refs: { peak: 80 } }); //  refFrac 20/80  = 0.25 → 90°
    b.r.updateBellyTank();
    const angleB = b.el.querySelector(".br-tick")!.getAttribute("transform");
    expect(angleA).toBe("rotate(36.00 24 24)");
    expect(angleB).toBe("rotate(90.00 24 24)");
  });

  it("toggles hungry when fullness drops under the reference", () => {
    const { r, el, setMarker } = setup();
    r.updateBellyTank();
    expect(el.classList.contains("hungry")).toBe(false);
    setMarker(NOW + 90 * 60000); // last feed now 2 h old → ≈13.5 ml < day ref 20
    r.updateBellyTank();
    expect(el.classList.contains("hungry")).toBe(true);
  });

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

  it("refreshes the aria-label ml even when frac stays clamped and the token is unchanged", () => {
    // Peak deliberately low so fullness clamps frac to 1 well before the
    // marker scrub below pushes f even higher.
    const { r, el, setMarker } = setup({ refs: { peak: 40 } });
    r.updateBellyTank();
    const label1 = el.getAttribute("aria-label");
    const fill1 = el.querySelector(".br-fill")!.getAttribute("stroke-dasharray");
    // Earlier marker → the most-recent feed (30 min old at NOW) is only
    // 15 min old here → higher fullness, but still far past peak 40, so
    // frac stays pinned at 1 (asserted below) while the ml keeps rising.
    setMarker(NOW - 15 * 60000);
    r.updateBellyTank();
    const label2 = el.getAttribute("aria-label");
    const fill2 = el.querySelector(".br-fill")!.getAttribute("stroke-dasharray");
    expect(fill2).toBe(fill1); // frac clamped both times — the old sig would collide
    const ml1 = Number(label1!.match(/belly ≈ (\d+) ml/)![1]);
    const ml2 = Number(label2!.match(/belly ≈ (\d+) ml/)![1]);
    expect(ml2).not.toBe(ml1); // but the label's own ml must still refresh
  });

  it("ships the es translation for the overdue caption", async () => {
    const { readFileSync } = await import("node:fs");
    const here = import.meta.url;
    const html = readFileSync(new URL("../src/app.html", here), "utf8");
    expect(html).toContain('"usually fed by ~{t}":');
  });
});

// The centre countdown is the ring's headline glance ("when's the next feed?").
// Its magnitude-adaptive buckets were essentially unasserted. Drive each branch
// deterministically: a single 100 ml feed at NOW drains on the kernel's own
// curve, so setting the class reference to the fullness at (C − ½) min forces
// the crossing to land at exactly C minutes (hungerCrossMs steps whole minutes).
describe("belly ring countdown token", () => {
  const K = kernel(); // same anchor kernel the ring uses for <20 feeds
  const feedNow = [{ ts: new Date(NOW).toISOString(), amount_ml: 100 }];
  // medFeedMl falls back to 120 for a single feed, so decay uses m = 120.
  const refsCrossingAt = (mins: number) => ({
    day: 100 * K.remFrac((mins - 0.5) * 60000, 100, 120),
    night: 100 * K.remFrac((mins - 0.5) * 60000, 100, 120),
    peak: 200,
    firstMs: 0,
    n: 30,
  });

  const M = (n: number) => n + '<i class="br-unit">m</i>';
  const HR = (n: number, half: boolean) =>
    n + '<i class="br-unit">' + (half ? "½h" : "h") + "</i>";

  it("maps each crossing distance to its bucket string", () => {
    const { r } = setup();
    // < 15 min → "soon"
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(8), 0)).toBe("soon");
    // 15–55 min → 5-min-rounded minutes with the feed-hue unit
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(30), 0)).toBe(M(30));
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(45), 0)).toBe(M(45));
    // 55–60 min rounds up to the hour → falls through to "1h" (not "60m")
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(58), 0)).toBe(HR(1, false));
    // whole and half hours
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(61), 0)).toBe(HR(1, false));
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(90), 0)).toBe(HR(1, true));
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(120), 0)).toBe(HR(2, false));
  });

  it("says 'now' when already under the reference", () => {
    const { r } = setup();
    // Reference above the current 100 ml fullness → hungry at NOW → "now".
    const refs = { day: 150, night: 150, peak: 300, firstMs: 0, n: 30 };
    expect(r.bellyCountdownToken(feedNow, refs, 0)).toBe("now");
  });

  it("falls back to the belly ml (rounded, tiny unit) when the marker is in the past", () => {
    const { r } = setup({ atNow: false }); // stripMarkerMin < rsNowMin → no countdown
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(30), 76)).toBe(
      '76<i class="br-ml">ml</i>'
    );
  });

  it("falls back to the belly ml when no crossing lands within 12h", () => {
    const { r } = setup(); // marker at now, but the reference is never reached
    const refs = { day: 0, night: 0, peak: 200, firstMs: 0, n: 30 };
    expect(r.bellyCountdownToken(feedNow, refs, 42)).toBe(
      '42<i class="br-ml">ml</i>'
    );
  });
});
