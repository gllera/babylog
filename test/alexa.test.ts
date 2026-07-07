import { describe, it, expect } from "vitest";
import { langOf, VOICES } from "../src/alexa-i18n";

describe("langOf", () => {
  it("maps en-US and en-GB to en", () => {
    expect(langOf("en-US")).toBe("en");
    expect(langOf("en-GB")).toBe("en");
  });

  it("is case-insensitive", () => {
    expect(langOf("EN-us")).toBe("en");
  });

  it("maps es-ES to es", () => {
    expect(langOf("es-ES")).toBe("es");
  });

  it("defaults to es for missing or unknown locales", () => {
    expect(langOf(undefined)).toBe("es");
    expect(langOf("")).toBe("es");
    expect(langOf("fr-FR")).toBe("es");
  });
});

describe("voiceEn.humanGap", () => {
  const v = VOICES.en;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("handles negative deltas", () => {
    expect(v.humanGap(-1000)).toBe("in the future");
  });

  it("handles sub-minute", () => {
    expect(v.humanGap(10_000)).toBe("less than a minute");
  });

  it("singular vs plural minutes", () => {
    expect(v.humanGap(MIN)).toBe("a minute");
    expect(v.humanGap(10 * MIN)).toBe("10 minutes");
  });

  it("hours with minutes", () => {
    expect(v.humanGap(HOUR)).toBe("an hour");
    expect(v.humanGap(2 * HOUR + 10 * MIN)).toBe("2 hours and 10 minutes");
    expect(v.humanGap(HOUR + MIN)).toBe("an hour and a minute");
  });

  it("days with hours", () => {
    expect(v.humanGap(DAY)).toBe("a day");
    expect(v.humanGap(2 * DAY + 3 * HOUR)).toBe("2 days and 3 hours");
    expect(v.humanGap(DAY + HOUR)).toBe("a day and an hour");
  });
});

describe("voiceEn fragments", () => {
  const v = VOICES.en;

  it("diaperKind", () => {
    expect(v.diaperKind("pee")).toBe("pee");
    expect(v.diaperKind("poop")).toBe("poop");
    expect(v.diaperKind("both")).toBe("pee and poop");
  });

  it("routineDisplay maps canonical English names", () => {
    expect(v.routineDisplay("Vitamin D")).toBe("vitamin D");
    expect(v.routineDisplay("Tummy")).toBe("tummy time");
    expect(v.routineDisplay("Bath")).toBe("bath");
    // Unknown canonical falls back to itself.
    expect(v.routineDisplay("Something")).toBe("Something");
  });

  it("feedingRecorded", () => {
    expect(v.feedingRecorded(120, "")).toBe("120 milliliters.");
    expect(v.feedingRecorded(120, ", an hour")).toBe("120 milliliters, an hour.");
  });

  it("feedingSummary pluralizes", () => {
    expect(v.feedingSummary(1, 100)).toBe("1 feeding, 100 milliliters.");
    expect(v.feedingSummary(3, 450)).toBe("3 feedings, 450 milliliters.");
  });

  it("diaperSummary pluralizes and joins", () => {
    expect(v.diaperSummary(1, 0)).toBe("1 pee.");
    expect(v.diaperSummary(2, 1)).toBe("2 pees, 1 poop.");
    expect(v.diaperSummary(0, 3)).toBe("3 poops.");
  });

  it("routineSummary pluralizes with times", () => {
    expect(v.routineSummary([{ name: "Bath", n: 1 }])).toBe("bath.");
    expect(
      v.routineSummary([
        { name: "Bath", n: 1 },
        { name: "Walk", n: 2 },
      ])
    ).toBe("bath, walk 2 times.");
  });

  it("lastAt and lastFeeding", () => {
    expect(v.lastAt("20:10")).toBe("Last at 20:10.");
    expect(v.lastFeeding("an hour", "20:10", 120)).toBe(
      "The last feeding was an hour ago, at 20:10, of 120 milliliters."
    );
  });

  it("gapTail formats a gap from the previous entry", () => {
    const now = 10 * 60_000;
    const prev = { ts: new Date(0).toISOString() };
    expect(v.gapTail(prev, now)).toBe(", 10 minutes");
    expect(v.gapTail(undefined, now)).toBe("");
  });
});

// Characterization tests locking the existing Spanish behavior through the
// refactor into the voice layer.
describe("voiceEs (unchanged behavior)", () => {
  const v = VOICES.es;

  it("humanGap", () => {
    expect(v.humanGap(90 * 60_000)).toBe("una hora y 30 minutos");
    expect(v.humanGap(10_000)).toBe("menos de un minuto");
  });

  it("diaperKind", () => {
    expect(v.diaperKind("both")).toBe("pis y caca");
  });

  it("feedingSummary", () => {
    expect(v.feedingSummary(3, 450)).toBe("3 tomas, 450 mililitros.");
  });

  it("diaperSummary", () => {
    expect(v.diaperSummary(2, 1)).toBe("2 pises, 1 caca.");
  });

  it("routineDisplay", () => {
    expect(v.routineDisplay("Bath")).toBe("baño");
  });
});
