import { describe, it, expect } from "vitest";
import {
  computeAgeParts,
  computeAge,
  normalizeTs,
  humanizeGap,
  formatGap,
  maxGapMinutes,
  buildWindowClauses,
  madridOffsetHours,
  madridDateOf,
  addDaysIso,
  madridMidnightUtc,
  madridDayWindow,
  madridHHMM,
  escapeLike,
  feedingMergeWindow,
  FEEDING_MERGE_WINDOW_MIN,
} from "../src/lib";

describe("computeAgeParts", () => {
  it("is 0 days on the day of birth", () => {
    const p = computeAgeParts("2026-04-01", new Date("2026-04-01T10:00:00Z"));
    expect(p).toEqual({ days: 0, weeks: 0, remDays: 0, years: 0, months: 0 });
  });

  it("returns null before birth", () => {
    expect(
      computeAgeParts("2026-04-01", new Date("2026-03-31T10:00:00Z"))
    ).toBeNull();
  });

  it("returns null (not NaN parts) for a regex-valid but impossible DOB", () => {
    // A DOB like this passes the /^\d{4}-\d{2}-\d{2}$/ gate but is Invalid Date;
    // it must not leak NaN into age math or the growth-target tiers.
    expect(computeAgeParts("2026-13-45", new Date("2026-05-01T00:00:00Z"))).toBeNull();
    expect(computeAgeParts("2026-00-00", new Date("2026-05-01T00:00:00Z"))).toBeNull();
  });

  it("counts whole calendar days at UTC midnight (civil-day age anchor)", () => {
    // check_indications anchors age at `${day}T00:00:00Z`; verify that yields
    // the exact calendar-day count (0 on the birth day, 42 six weeks on).
    expect(computeAgeParts("2026-01-01", new Date("2026-01-01T00:00:00Z"))?.days).toBe(0);
    expect(computeAgeParts("2026-01-01", new Date("2026-02-12T00:00:00Z"))?.days).toBe(42);
  });

  it("handles month-end boundaries (born Jan 31 → Mar 1 is 1 month)", () => {
    const p = computeAgeParts("2025-01-31", new Date("2025-03-01T00:00:00Z"));
    expect(p).toMatchObject({ days: 29, weeks: 4, remDays: 1, months: 1, years: 0 });
  });

  it("rolls months into years", () => {
    const p = computeAgeParts("2025-04-01", new Date("2026-05-15T00:00:00Z"));
    expect(p).toMatchObject({ years: 1, months: 1 });
  });
});

describe("computeAge (impossible DOB)", () => {
  it("says 'not yet born' instead of 'NaNy NaNm old'", () => {
    expect(computeAge("2026-13-45", new Date("2026-05-01T00:00:00Z"))).toBe(
      "not yet born"
    );
  });
});

describe("escapeLike", () => {
  it("escapes LIKE wildcards and the escape char", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_c")).toBe("a\\_c");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLike("vitamin d")).toBe("vitamin d");
  });
});

describe("computeAge", () => {
  it("speaks days for newborns", () => {
    expect(computeAge("2026-04-01", new Date("2026-04-04T12:00:00Z"))).toBe(
      "3 days old"
    );
  });

  it("speaks weeks under 60 days", () => {
    expect(computeAge("2026-04-01", new Date("2026-05-01T12:00:00Z"))).toBe(
      "30 days old (4w 2d)"
    );
  });

  it("speaks months under a year", () => {
    expect(computeAge("2026-01-01", new Date("2026-06-10T12:00:00Z"))).toBe(
      "5 months old (160 days)"
    );
  });
});

describe("normalizeTs", () => {
  it("normalizes second-precision input to millisecond precision", () => {
    expect(normalizeTs("2026-05-14T07:30:00Z")).toBe("2026-05-14T07:30:00.000Z");
  });

  it("keeps canonical input unchanged", () => {
    expect(normalizeTs("2026-05-14T07:30:00.000Z")).toBe(
      "2026-05-14T07:30:00.000Z"
    );
  });

  it("returns current time in canonical form when omitted", () => {
    expect(normalizeTs()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("converts timezone-offset input to UTC", () => {
    expect(normalizeTs("2026-06-10T14:30:00+02:00")).toBe(
      "2026-06-10T12:30:00.000Z"
    );
    expect(normalizeTs("2026-01-10T08:00:00+01:00")).toBe(
      "2026-01-10T07:00:00.000Z"
    );
  });
});

describe("humanizeGap", () => {
  it.each([
    [20_000, "<1 min"],
    [5 * 60_000, "5 min"],
    [60 * 60_000, "1h"],
    [90 * 60_000, "1h 30m"],
    [24 * 60 * 60_000, "1d"],
    [26 * 60 * 60_000, "1d 2h"],
    [-1, "in the future"],
  ])("%d ms → %s", (ms, expected) => {
    expect(humanizeGap(ms)).toBe(expected);
  });
});

describe("formatGap", () => {
  it("returns empty parts without a previous timestamp", () => {
    expect(formatGap("2026-05-14T07:30:00Z", null)).toEqual({
      gapStr: null,
      gapMin: null,
      gapNote: "",
    });
  });

  it("formats the gap and note with a suffix", () => {
    const g = formatGap("2026-05-14T07:30:00Z", "2026-05-14T04:00:00Z", "Bath");
    expect(g.gapMin).toBe(210);
    expect(g.gapStr).toBe("3h 30m");
    expect(g.gapNote).toBe("  (3h 30m since previous Bath)");
  });
});

describe("maxGapMinutes", () => {
  it("is 0 with no timestamps", () => {
    expect(maxGapMinutes([], "2026-06-10T22:00:00.000Z")).toBe(0);
  });

  it("counts the trailing gap to the boundary for a single feeding", () => {
    expect(
      maxGapMinutes(["2026-06-10T08:00:00.000Z"], "2026-06-10T10:00:00.000Z")
    ).toBe(120);
  });

  it("takes the max of in-between and trailing gaps", () => {
    expect(
      maxGapMinutes(
        ["2026-06-10T06:00:00.000Z", "2026-06-10T09:00:00.000Z"],
        "2026-06-10T09:30:00.000Z"
      )
    ).toBe(180);
  });

  it("measures across the window start via a predecessor timestamp", () => {
    // last feeding yesterday 22:00, first today 04:00 → 6h gap
    expect(
      maxGapMinutes(
        ["2026-06-09T22:00:00.000Z", "2026-06-10T04:00:00.000Z"],
        "2026-06-10T05:00:00.000Z"
      )
    ).toBe(360);
  });

  it("ignores a boundary earlier than the last timestamp", () => {
    expect(
      maxGapMinutes(
        ["2026-06-10T08:00:00.000Z", "2026-06-10T09:00:00.000Z"],
        "2026-06-10T08:30:00.000Z"
      )
    ).toBe(60);
  });
});

describe("buildWindowClauses", () => {
  it("builds nothing without bounds", () => {
    expect(buildWindowClauses()).toEqual({ clauses: [], params: [] });
  });

  it("builds since/until clauses in order", () => {
    expect(
      buildWindowClauses("2026-06-10T06:00:00.000Z", "2026-06-10T20:00:00.000Z")
    ).toEqual({
      clauses: ["ts >= ?", "ts < ?"],
      params: ["2026-06-10T06:00:00.000Z", "2026-06-10T20:00:00.000Z"],
    });
  });

  // Stored ts strings are canonical toISOString() form compared
  // lexicographically — offset or second-precision bounds must be
  // canonicalized or the string comparison is wrong by whole hours.
  it("canonicalizes timezone-offset bounds to UTC", () => {
    expect(
      buildWindowClauses("2026-06-10T08:00:00+02:00", "2026-06-10T22:00:00+02:00")
        .params
    ).toEqual(["2026-06-10T06:00:00.000Z", "2026-06-10T20:00:00.000Z"]);
  });

  it("canonicalizes second-precision bounds to millisecond precision", () => {
    expect(buildWindowClauses("2026-06-10T06:00:00Z").params).toEqual([
      "2026-06-10T06:00:00.000Z",
    ]);
  });
});

describe("madridOffsetHours", () => {
  it("is +1 (CET) in winter and +2 (CEST) in summer", () => {
    expect(madridOffsetHours(new Date("2026-01-15T12:00:00Z"))).toBe(1);
    expect(madridOffsetHours(new Date("2026-07-15T12:00:00Z"))).toBe(2);
  });

  it("switches at 01:00 UTC on the last Sunday of March 2026 (Mar 29)", () => {
    expect(madridOffsetHours(new Date("2026-03-29T00:59:59Z"))).toBe(1);
    expect(madridOffsetHours(new Date("2026-03-29T01:00:00Z"))).toBe(2);
  });

  it("switches back at 01:00 UTC on the last Sunday of October 2026 (Oct 25)", () => {
    expect(madridOffsetHours(new Date("2026-10-25T00:59:59Z"))).toBe(2);
    expect(madridOffsetHours(new Date("2026-10-25T01:00:00Z"))).toBe(1);
  });
});

describe("madridDateOf", () => {
  it("rolls late-evening UTC into the next Madrid day in summer", () => {
    expect(madridDateOf(new Date("2026-06-09T22:30:00Z"))).toBe("2026-06-10");
  });

  it("keeps the same date when local midnight is not yet crossed", () => {
    expect(madridDateOf(new Date("2026-06-09T21:30:00Z"))).toBe("2026-06-09");
  });

  it("uses the +1 offset in winter", () => {
    expect(madridDateOf(new Date("2026-01-09T23:30:00Z"))).toBe("2026-01-10");
    expect(madridDateOf(new Date("2026-01-09T22:30:00Z"))).toBe("2026-01-09");
  });
});

describe("addDaysIso", () => {
  it("crosses month boundaries", () => {
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("madridMidnightUtc", () => {
  it("is 22:00 UTC the day before in summer", () => {
    expect(madridMidnightUtc("2026-06-10").toISOString()).toBe(
      "2026-06-09T22:00:00.000Z"
    );
  });

  it("is 23:00 UTC the day before in winter", () => {
    expect(madridMidnightUtc("2026-01-10").toISOString()).toBe(
      "2026-01-09T23:00:00.000Z"
    );
  });
});

describe("madridDayWindow", () => {
  it("covers one Madrid day by default", () => {
    expect(madridDayWindow("2026-06-10")).toEqual({
      start: "2026-06-09T22:00:00.000Z",
      end: "2026-06-10T22:00:00.000Z",
    });
  });

  it("extends back for multi-day periods", () => {
    expect(madridDayWindow("2026-06-10", 2).start).toBe(
      "2026-06-08T22:00:00.000Z"
    );
  });

  it("handles windows spanning the spring DST change", () => {
    // Mar 28 starts in CET (+1), Mar 29 ends in CEST (+2): a 47-hour window.
    expect(madridDayWindow("2026-03-29", 2)).toEqual({
      start: "2026-03-27T23:00:00.000Z",
      end: "2026-03-29T22:00:00.000Z",
    });
  });
});

describe("madridHHMM", () => {
  it("formats UTC instants in Madrid local time", () => {
    expect(madridHHMM("2026-06-10T07:05:00Z")).toBe("9:05");
    expect(madridHHMM("2026-01-10T07:05:00Z")).toBe("8:05");
  });
});

describe("feedingMergeWindow", () => {
  it("spans the merge window on both sides of ts", () => {
    expect(feedingMergeWindow("2026-06-10T12:00:00.000Z")).toEqual({
      start: "2026-06-10T11:50:00.000Z",
      end: "2026-06-10T12:10:00.000Z",
    });
  });

  it("stays canonical-ISO so it compares lexicographically with stored ts", () => {
    const { start, end } = feedingMergeWindow(new Date().toISOString());
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("width follows FEEDING_MERGE_WINDOW_MIN", () => {
    const { start, end } = feedingMergeWindow("2026-06-10T12:00:00.000Z");
    expect(Date.parse(end) - Date.parse(start)).toBe(
      2 * FEEDING_MERGE_WINDOW_MIN * 60_000
    );
  });
});
