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
});
