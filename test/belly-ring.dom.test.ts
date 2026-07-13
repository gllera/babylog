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
// A single 100 ml feed AT the marker instant → belly reads exactly full
// (remFrac(0) = 1), so fullness/peak underline widths are deterministic.
const feedNow = [{ ts: new Date(NOW).toISOString(), amount_ml: 100 }];

// The terse countdown format on the chip face: minutes under an hour ("~30m"),
// hours + optional 15/30/45 at or above ("~1h", "~1h30"); "+"-prefixed once
// overdue past the grace, "now" at due. The unit letter rides small on the
// digits' baseline (.br-unit), matching the ml fallback.
const unit = (u: string) => `<i class="br-unit">${u}</i>`;
const MIN = (n: number, p = "~") => `${p}${n}${unit("m")}`;
const HR = (h: number, mm = 0, p = "~") =>
  `${p}${h}${unit("h")}${String(mm).padStart(2, "0")}`;
// A well-formed countdown/overdue token (never the bare-ml fallback). The hour
// band always carries 2-digit minutes (00/15/30/45) so the width holds.
const CD_RE = /^[~+](\d+<i class="br-unit">m<\/i>|\d+<i class="br-unit">h<\/i>(00|15|30|45))$/;

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

describe("belly disc DOM", () => {
  it("builds the disc once, with the time-left token and fullness underline, no gauge", () => {
    const { r, el } = setup();
    r.updateBellyTank();
    expect(el.hidden).toBe(false);
    expect(el.querySelector(".br-disc")).toBeTruthy();
    expect(el.querySelector(".br-token")!.textContent).not.toBe("");
    // the fullness underline is present…
    expect(el.querySelector(".br-level")).toBeTruthy();
    // …but the radial gauge (arc + reserve tick) is still gone
    expect(el.querySelector(".br-fill")).toBeNull();
    expect(el.querySelector(".br-track")).toBeNull();
    expect(el.querySelector(".br-tick")).toBeNull();
  });

  it("sizes the fullness underline to fullness / peak", () => {
    const { r, el } = setup({ feeds: feedNow, refs: { peak: 200 } });
    r.updateBellyTank();
    // 100 ml at the marker instant → belly full; peak 200 → half-swept.
    expect(parseFloat((el.querySelector(".br-level") as HTMLElement).style.width)).toBeCloseTo(50, 0);
  });

  it("clamps the underline to full when fullness exceeds peak", () => {
    const { r, el } = setup({ feeds: feedNow, refs: { peak: 50 } });
    r.updateBellyTank();
    expect(parseFloat((el.querySelector(".br-level") as HTMLElement).style.width)).toBe(100);
  });

  it("floors the underline to a sliver for a non-empty belly", () => {
    const { r, el } = setup({ feeds: feedNow, refs: { peak: 4000 } });
    r.updateBellyTank();
    // 100 / 4000 = 2.5% is below the sliver floor, so a non-empty belly still shows.
    expect(parseFloat((el.querySelector(".br-level") as HTMLElement).style.width)).toBe(5);
  });

  it("stays hidden when gated off", () => {
    const { r, el } = setup({ gated: true });
    r.updateBellyTank();
    expect(el.hidden).toBe(true);
  });

  it("patches the disc in place across updates (node identity preserved)", () => {
    const { r, el, setMarker } = setup();
    r.updateBellyTank();
    const disc = el.querySelector(".br-disc")!;
    const token = el.querySelector(".br-token")!;
    const level = el.querySelector(".br-level")!;
    expect(el.classList.contains("hungry")).toBe(false);
    setMarker(NOW + 90 * 60000); // scrub forward → fullness under ref → hungry (disc reddens)
    r.updateBellyTank();
    // Same nodes, not an innerHTML rebuild — so the background colour and the
    // underline width can ease instead of snapping.
    expect(el.querySelector(".br-disc")).toBe(disc);
    expect(el.querySelector(".br-token")).toBe(token);
    expect(el.querySelector(".br-level")).toBe(level);
    expect(el.classList.contains("hungry")).toBe(true);
  });

  it("toggles hungry when fullness drops under the reference", () => {
    const { r, el, setMarker } = setup();
    r.updateBellyTank();
    expect(el.classList.contains("hungry")).toBe(false);
    setMarker(NOW + 90 * 60000); // last feed now 2 h old → ≈13.5 ml < day ref 20
    r.updateBellyTank();
    expect(el.classList.contains("hungry")).toBe(true);
  });

  it("labels the disc for assistive tech: belly ml, countdown riding along", () => {
    const { r, el } = setup();
    r.updateBellyTank();
    // ≈76 ml in the belly, a crossing about an hour out → token rides the label.
    expect(el.getAttribute("aria-label")).toMatch(/^belly ≈ \d+ ml · /);
  });

  it("still shows a time-left countdown when scrubbed into the past (not a bare ml)", () => {
    const { r, el, setMarker } = setup();
    setMarker(NOW - 120 * 60000); // scrub the marker 2 h into the past
    r.updateBellyTank();
    // The countdown is measured from the marker (draining only the feeds up to
    // it), so the aria still reads "belly ≈ N ml · <time-left>", never a lone ml.
    expect(el.getAttribute("aria-label")).toMatch(/^belly ≈ \d+ ml · /);
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

  it("re-renders as the marker moves (the readout follows the marker, not just now)", () => {
    const { r, el, setMarker } = setup();
    r.updateBellyTank();
    const label1 = el.getAttribute("aria-label");
    // A different marker → a different belly ml and a marker-anchored countdown,
    // so the no-op signature must not collide (the disc reads the past moment).
    setMarker(NOW - 150 * 60000);
    r.updateBellyTank();
    expect(el.getAttribute("aria-label")).not.toBe(label1);
  });

  it("ships the es translation for the overdue caption", async () => {
    const { readFileSync } = await import("node:fs");
    const here = import.meta.url;
    const html = readFileSync(new URL("../src/app.html", here), "utf8");
    expect(html).toContain('"usually fed by ~{t}":');
  });
});

// The countdown is the disc's headline glance ("when's the next feed?"). Drive
// each branch deterministically: a single 100 ml feed at NOW drains on the
// kernel's own curve, so setting the class reference to the fullness at (C − ½)
// min forces the *forward* crossing to land at exactly C minutes; setting it to
// the fullness at (59 − E) min (with the feed 60 min old) forces the *past*
// crossing to land exactly E minutes ago. hungerCrossMs/PastMs step whole minutes.
describe("belly disc countdown token", () => {
  const K = kernel(); // same anchor kernel the ring uses for <20 feeds
  // medFeedMl falls back to 120 for a single feed, so decay uses m = 120.
  const refsCrossingAt = (mins: number) => ({
    day: 100 * K.remFrac((mins - 0.5) * 60000, 100, 120),
    night: 100 * K.remFrac((mins - 0.5) * 60000, 100, 120),
    peak: 200,
    firstMs: 0,
    n: 30,
  });
  // A feed 60 min old + a reference at its (59 − E)-min fullness → she is
  // already overdue at NOW and crossed exactly E minutes ago.
  const feed60 = [{ ts: new Date(NOW - 60 * 60000).toISOString(), amount_ml: 100 }];
  const refsPastCrossingAt = (elapsedMin: number) => {
    const r = 100 * K.remFrac((59 - elapsedMin) * 60000, 100, 120);
    return { day: r, night: r, peak: 200, firstMs: 0, n: 30 };
  };

  it("shows minutes under an hour and hours+minutes above, tightening as it nears", () => {
    const { r } = setup({ feeds: feedNow });
    // ≥ 1 h: nearest 15 min, minutes always shown (even "00" on the hour) so the
    // token width doesn't jump.
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(120), 0)).toBe(HR(2)); // ~2h00
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(90), 0)).toBe(HR(1, 30));
    // Just under an hour still rounds up into the hour band (never "~60m").
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(58), 0)).toBe(HR(1)); // ~1h00
    // < 1 h: nearest 5 min, in minutes.
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(45), 0)).toBe(MIN(45));
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(30), 0)).toBe(MIN(30));
    // …with more resolution as it gets close, floored at ~5m (never "~0m").
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(8), 0)).toBe(MIN(10));
    expect(r.bellyCountdownToken(feedNow, refsCrossingAt(2), 0)).toBe(MIN(5));
  });

  it("says 'now' at the moment she's due (within the grace)", () => {
    const { r } = setup();
    // Reference above the current 100 ml fullness → hungry at NOW, just crossed.
    const refs = { day: 150, night: 150, peak: 300, firstMs: 0, n: 30 };
    expect(r.bellyCountdownToken(feedNow, refs, 0)).toBe("now");
  });

  it("counts up in minutes just past the grace", () => {
    const { r } = setup({ feeds: feed60 });
    // Crossed 20 min ago → "+20m" (a 60-min-old feed can place a crossing 20 min back).
    expect(r.bellyCountdownToken(feed60, refsPastCrossingAt(20), 0)).toBe(MIN(20, "+"));
  });

  it("escalates into the hour band for a long-overdue nap", () => {
    const { r } = setup();
    // A 100 ml feed 5 h ago is long empty; she has been overdue for hours, so the
    // face reads a "+"-prefixed HOUR token (not minutes, and not a flat "now").
    const drained = [{ ts: new Date(NOW - 5 * 3600000).toISOString(), amount_ml: 100 }];
    const refs = { day: 30, night: 30, peak: 200, firstMs: 0, n: 30 };
    expect(r.bellyCountdownToken(drained, refs, 0)).toMatch(/^\+\d+<i class="br-unit">h<\/i>/);
  });

  it("holds a flat 'now' inside the grace, not an escalation", () => {
    const { r } = setup({ feeds: feed60 });
    // Crossed only 5 min ago → still "now", not "+5m".
    expect(r.bellyCountdownToken(feed60, refsPastCrossingAt(5), 0)).toBe("now");
  });

  it("anchors the countdown at the marker — scrubbed into the past it shows a time-left, not the ml", () => {
    const { r, setMarker } = setup();
    // A feed at NOW−90; scrub the marker to NOW−60 (30 min after that feed).
    // The forecast is measured from the marker, so it reads a time, not the ml.
    const feeds = [{ ts: new Date(NOW - 90 * 60000).toISOString(), amount_ml: 100 }];
    setMarker(NOW - 60 * 60000);
    const token = r.bellyCountdownToken(feeds, { day: 20, night: 20, peak: 200, firstMs: 0, n: 30 }, 999);
    expect(token).not.toContain("br-ml"); // the belly ml (999) is never shown
    expect(token === "now" || CD_RE.test(token)).toBe(true);
  });

  it("ignores feeds after the marker (a later feed can't refill the past forecast)", () => {
    const { r, setMarker } = setup();
    // Marker at NOW−120. The 100 ml feed 30 min before it drains under 20 ml
    // ~1 h out (≈NOW−56). A big 240 ml feed lands at NOW−90 — AFTER the marker,
    // and before that natural crossing. The capped search must not see it: if it
    // did, fullness would jump and the countdown would balloon to multiple hours.
    const feeds = [
      { ts: new Date(NOW - 150 * 60000).toISOString(), amount_ml: 100 },
      { ts: new Date(NOW - 90 * 60000).toISOString(), amount_ml: 240 },
    ];
    const refs = { day: 20, night: 20, peak: 300, firstMs: 0, n: 30 };
    setMarker(NOW - 120 * 60000);
    // ~1 h out, not the ~4 h an uncapped search would give — so it must not read
    // multiple hours (and must be a well-formed countdown, not an ml fallback).
    const token = r.bellyCountdownToken(feeds, refs, 0);
    expect(token).toMatch(CD_RE);
    expect(token).not.toMatch(/[~+][2-9]<i class="br-unit">h/);
  });

  it("counts down to empty (not a bare ml) when usually fed near-empty (ref≈0)", () => {
    const { r } = setup(); // marker at now; calibrated reference ~0 → no hunger crossing
    const refs = { day: 0, night: 0, peak: 200, firstMs: 0, n: 30 };
    // The BR_EMPTY_ML floor turns the missing crossing into a time-to-empty one,
    // so the disc shows a countdown (here a couple hours out) instead of a bare ml.
    const token = r.bellyCountdownToken(feedNow, refs, 42);
    expect(token).not.toContain("br-ml");
    expect(token).toMatch(CD_RE);
  });

  it("reads a due token (not a bare ml) once essentially empty even at a ~0 reference", () => {
    const { r } = setup();
    const refs = { day: 0, night: 0, peak: 200, firstMs: 0, n: 30 };
    // A single feed 6 h ago is fully digested → fullness 0, under BR_EMPTY_ML;
    // she reads a due indicator — "now" if just crossed, else the "+"-escalation.
    const drained = [{ ts: new Date(NOW - 6 * 3600000).toISOString(), amount_ml: 100 }];
    const token = r.bellyCountdownToken(drained, refs, 0);
    expect(token).not.toContain("br-ml");
    expect(token === "now" || /^\+/.test(token)).toBe(true);
  });
});

// The warm-up glow: the chip warms toward amber in the final minutes before she
// is due, so a glance gets lead time. Driven off the same marker-relative
// crossing as the token.
describe("belly disc warm-up", () => {
  const K = kernel();
  const refsCrossingAt = (mins: number) => {
    const r = 100 * K.remFrac((mins - 0.5) * 60000, 100, 120);
    return { day: r, night: r, peak: 200, firstMs: 0, n: 30 };
  };

  it("warms the chip within the final minutes before due", () => {
    const { r, el } = setup({ feeds: feedNow, refs: refsCrossingAt(8) });
    r.updateBellyTank();
    expect(el.classList.contains("warming")).toBe(true);
    expect(el.classList.contains("hungry")).toBe(false);
  });

  it("does not warm while the next feed is still well out", () => {
    const { r, el } = setup({ feeds: feedNow, refs: refsCrossingAt(30) });
    r.updateBellyTank();
    expect(el.classList.contains("warming")).toBe(false);
  });

  it("does not warm once she is already hungry (the full amber owns that)", () => {
    const { r, el } = setup({ feeds: feedNow, refs: { day: 150, night: 150 } });
    r.updateBellyTank();
    expect(el.classList.contains("hungry")).toBe(true);
    expect(el.classList.contains("warming")).toBe(false);
  });
});
