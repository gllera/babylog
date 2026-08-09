import { describe, it, expect } from "vitest";
import { langOf, VOICES } from "../src/alexa-i18n";
import { classifyDiaperKind } from "../src/alexa";

describe("classifyDiaperKind", () => {
  // Combined phrasings must resolve to poop (a wet+dirty diaper is the messy
  // one) — the bug was that "wet"/"dirty" were absent from the combined regex,
  // so "wet and dirty" fell through to the pee-only branch.
  it("combined phrasings resolve to poop", () => {
    expect(classifyDiaperKind("wet and dirty")).toBe("poop");
    expect(classifyDiaperKind("pee and dirty")).toBe("poop");
    expect(classifyDiaperKind("dirty and wet")).toBe("poop");
    expect(classifyDiaperKind("pee and poop")).toBe("poop");
    expect(classifyDiaperKind("pis y caca")).toBe("poop");
    expect(classifyDiaperKind("mojado y sucio")).toBe("poop");
    expect(classifyDiaperKind("both")).toBe("poop");
  });

  it("single pee phrasings", () => {
    expect(classifyDiaperKind("pee")).toBe("pee");
    expect(classifyDiaperKind("wet")).toBe("pee");
    expect(classifyDiaperKind("mojado")).toBe("pee");
    expect(classifyDiaperKind("pis")).toBe("pee");
    expect(classifyDiaperKind("number one")).toBe("pee");
  });

  // A wet-only utterance that also names (and negates) a dirty term must stay
  // pee — the old `.*`-bridge combined regex spanned the negation and the bare
  // "todo", misreading these as poop.
  it("negated / all-wet phrasings stay pee", () => {
    expect(classifyDiaperKind("wet but not dirty")).toBe("pee");
    expect(classifyDiaperKind("wet, no poop")).toBe("pee");
    expect(classifyDiaperKind("mojado, no caca")).toBe("pee");
    expect(classifyDiaperKind("mojado sin caca")).toBe("pee");
    expect(classifyDiaperKind("todo mojado")).toBe("pee");
  });

  // Both-markers and non-negated distant mentions still resolve to poop.
  it("explicit both-markers and distant wet+dirty resolve to poop", () => {
    expect(classifyDiaperKind("de todo")).toBe("poop");
    expect(classifyDiaperKind("wet and she pooped")).toBe("poop");
    expect(classifyDiaperKind("completo")).toBe("poop");
  });

  it("single poop phrasings", () => {
    expect(classifyDiaperKind("caca")).toBe("poop");
    expect(classifyDiaperKind("dirty")).toBe("poop");
    expect(classifyDiaperKind("sucio")).toBe("poop");
    expect(classifyDiaperKind("poop")).toBe("poop");
    expect(classifyDiaperKind("number two")).toBe("poop");
  });

  it("is case-insensitive and returns null when nothing matches", () => {
    expect(classifyDiaperKind("Wet And Dirty")).toBe("poop");
    expect(classifyDiaperKind("hello")).toBe(null);
    expect(classifyDiaperKind("")).toBe(null);
  });
});

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
  });

  it("routineDisplay maps canonical English names", () => {
    expect(v.routineDisplay("Vitamin D")).toBe("vitamin D");
    expect(v.routineDisplay("Tummy")).toBe("tummy time");
    expect(v.routineDisplay("Bath")).toBe("bath");
    // Unknown canonical falls back to itself.
    expect(v.routineDisplay("Something")).toBe("Something");
  });

  it("feedingRecorded", () => {
    expect(v.feedingRecorded(120, "")).toBe("Logged: 120 milliliters.");
    expect(v.feedingRecorded(120, ", an hour since the previous feeding")).toBe(
      "Logged: 120 milliliters, an hour since the previous feeding."
    );
  });

  it("feedingMerged speaks the top-up and the new total", () => {
    expect(v.feedingMerged(30, 150)).toBe(
      "Added 30 milliliters to the previous feeding: 150 in total."
    );
  });

  it("feedingSummary pluralizes and marks the total", () => {
    expect(v.feedingSummary(1, 100)).toBe("1 feeding, 100 milliliters.");
    expect(v.feedingSummary(3, 450)).toBe("3 feedings, 450 milliliters in total.");
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

  it("lastFeedingAt and lastFeeding name what the time refers to", () => {
    expect(v.lastFeedingAt("20:10")).toBe("Last feeding at 20:10.");
    expect(v.lastFeeding("an hour", "20:10", 120)).toBe(
      "The last feeding was an hour ago, at 20:10, of 120 milliliters."
    );
  });

  it("gapTail names what the gap refers to, per entity", () => {
    const now = 10 * 60_000;
    const prev = { ts: new Date(0).toISOString() };
    expect(v.gapTail(prev, now, "feeding")).toBe(", 10 minutes since the previous feeding");
    expect(v.gapTail(prev, now, "diaper")).toBe(", 10 minutes since the previous diaper");
    expect(v.gapTail(prev, now, "routine")).toBe(", 10 minutes since the last time");
    expect(v.gapTail(undefined, now, "feeding")).toBe("");
  });
});

describe("voiceEs", () => {
  const v = VOICES.es;

  it("humanGap", () => {
    expect(v.humanGap(90 * 60_000)).toBe("una hora y 30 minutos");
    expect(v.humanGap(10_000)).toBe("menos de un minuto");
  });

  it("diaperKind", () => {
    expect(v.diaperKind("pee")).toBe("pis");
    expect(v.diaperKind("poop")).toBe("caca");
  });

  it("feedingSummary marks the total", () => {
    expect(v.feedingSummary(1, 100)).toBe("1 toma, 100 mililitros.");
    expect(v.feedingSummary(3, 450)).toBe("3 tomas, 450 mililitros en total.");
  });

  it("diaperSummary", () => {
    expect(v.diaperSummary(2, 1)).toBe("2 pises, 1 caca.");
  });

  it("routineDisplay", () => {
    expect(v.routineDisplay("Bath")).toBe("baño");
  });

  it("record confirmations name what the gap refers to", () => {
    const now = 10 * 60_000;
    const prev = { ts: new Date(0).toISOString() };
    expect(v.feedingRecorded(120, v.gapTail(prev, now, "feeding"))).toBe(
      "Apuntado: 120 mililitros, 10 minutos desde la toma anterior."
    );
    expect(v.diaperRecorded("poop", v.gapTail(prev, now, "diaper"))).toBe(
      "Apuntado: caca, 10 minutos desde el pañal anterior."
    );
    expect(v.routineRecorded("Vitamin D", v.gapTail(prev, now, "routine"))).toBe(
      "Apuntado: vitamina D, 10 minutos desde la última vez."
    );
  });

  it("feedingMerged speaks the top-up and the new total", () => {
    expect(v.feedingMerged(30, 150)).toBe(
      "Añadidos 30 mililitros a la toma anterior: 150 en total."
    );
  });

  it("lastFeedingAt names the event", () => {
    expect(v.lastFeedingAt("20:10")).toBe("Última toma a las 20:10.");
  });
});

import { handleAlexa } from "../src/alexa";
import { mintLinkToken, ACCESS_TYP } from "../src/alexa-link";

const OAUTH_SECRET = "alexa-oauth-secret-32-bytes-long!!!!";

const strictEnv = (db: unknown) =>
  ({
    DB: db,
    ALEXA_SKIP_SIGNATURE: "true",
    ALEXA_OAUTH_HMAC_SECRET: OAUTH_SECRET,
  }) as never;

const envelope = (over: Record<string, unknown> = {}) => ({
  version: "1.0",
  context: {
    System: {
      application: { applicationId: "amzn1.ask.skill.test" },
      user: { userId: "u1", ...over },
    },
  },
  request: {
    type: "LaunchRequest",
    requestId: "r1",
    timestamp: new Date().toISOString(),
    locale: "en-US",
  },
});

const post = (body: unknown) =>
  new Request("https://baby.32b.io/alexa", { method: "POST", body: JSON.stringify(body) });

describe("strict account linking", () => {
  it("no token → LinkAccount card, localized speech, session ends", async () => {
    const res = await handleAlexa(post(envelope()), strictEnv({}));
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      response: { card?: { type: string }; outputSpeech?: { text?: string }; shouldEndSession: boolean };
    };
    expect(out.response.card?.type).toBe("LinkAccount");
    expect(out.response.outputSpeech?.text).toContain("link your account");
    expect(out.response.shouldEndSession).toBe(true);
  });

  it("an invalid/expired token behaves like no token", async () => {
    const stale = await mintLinkToken(
      { ALEXA_OAUTH_HMAC_SECRET: OAUTH_SECRET }, ACCESS_TYP,
      { sub: "u_1", email: "ana@example.com" }, -1
    );
    const res = await handleAlexa(post(envelope({ accessToken: stale })), strictEnv({}));
    const out = (await res.json()) as { response: { card?: { type: string } } };
    expect(out.response.card?.type).toBe("LinkAccount");
  });

  it("a linked email with no users row gets the invite line, not a crash", async () => {
    const tok = await mintLinkToken(
      { ALEXA_OAUTH_HMAC_SECRET: OAUTH_SECRET }, ACCESS_TYP,
      { sub: "u_1", email: "nobody@example.com" }, 60
    );
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
    const res = await handleAlexa(post(envelope({ accessToken: tok })), strictEnv(db));
    const out = (await res.json()) as {
      response: { card?: { type: string }; outputSpeech?: { text?: string } };
    };
    expect(out.response.card).toBeUndefined();
    expect(out.response.outputSpeech?.text).toContain("isn't in a household");
  });

  it("a linked user with a household passes the gate (launch prompt, no card)", async () => {
    const tok = await mintLinkToken(
      { ALEXA_OAUTH_HMAC_SECRET: OAUTH_SECRET }, ACCESS_TYP,
      { sub: "u_1", email: "ana@example.com" }, 60
    );
    const linkedDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ id: 1, email: "ana@example.com", household_id: 7 }),
          all: async () => ({
            results: [{ id: 3, household_id: 7, name: "Baby", sex: null, date_of_birth: null, is_default: 1 }],
          }),
        }),
      }),
    };
    const res = await handleAlexa(post(envelope({ accessToken: tok })), strictEnv(linkedDb));
    const out = (await res.json()) as {
      response: { card?: unknown; shouldEndSession: boolean };
    };
    expect(out.response.card).toBeUndefined();
    expect(out.response.shouldEndSession).toBe(false); // launch keeps the session open
  });

  it("the Spanish voice localizes the link prompt", async () => {
    const body = envelope();
    (body.request as { locale: string }).locale = "es-ES";
    const res = await handleAlexa(post(body), strictEnv({}));
    const out = (await res.json()) as { response: { outputSpeech?: { text?: string } } };
    expect(out.response.outputSpeech?.text).toContain("vincula tu cuenta");
  });

  it("a linked user whose household has zero babies gets a graceful spoken error, not a crash", async () => {
    const tok = await mintLinkToken(
      { ALEXA_OAUTH_HMAC_SECRET: OAUTH_SECRET }, ACCESS_TYP,
      { sub: "u_1", email: "ana@example.com" }, 60
    );
    // resolveTenant finds the user; getBabies returns an empty household.
    const emptyHouseholdDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ id: 1, email: "ana@example.com", household_id: 7 }),
          all: async () => ({ results: [] }),
        }),
      }),
    };
    const res = await handleAlexa(post(envelope({ accessToken: tok })), strictEnv(emptyHouseholdDb));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { response: { outputSpeech?: { text?: string } } };
    // The generic error line, never raw exception text.
    expect(out.response.outputSpeech?.text).toBeTruthy();
    expect(out.response.outputSpeech?.text).not.toContain("no babies");
  });
});
