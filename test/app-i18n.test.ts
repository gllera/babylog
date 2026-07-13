import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Read app.html's inline translations directly. A big flat i18n object is
// exactly where a duplicate key hides: JS object-literal last-wins silently
// shadows the earlier entry, so a mistyped/relocated key can defeat a
// deliberately-chosen translation with no error anywhere.
const here = import.meta.url;
const html = readFileSync(new URL("../src/app.html", here), "utf8");

// Extract a `lang: { ... }` translation object by brace matching. Safe here:
// the only braces inside string values are balanced i18n templates ({n}, {t}).
function langBlock(lang: string): string {
  const start = html.indexOf(lang + ": {");
  if (start < 0) throw new Error(lang + " block not found");
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error("unbalanced braces in " + lang + " block");
}

// Keys are always at line start (`  "key": "value",`); anchoring to the line
// keeps value text from matching.
const keysOf = (block: string) =>
  [...block.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].map((m) => m[1]);

describe("app.html es translations", () => {
  it("has no duplicate keys (a later dupe silently shadows the earlier)", () => {
    const keys = keysOf(langBlock("es"));
    const seen = new Set<string>();
    const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    expect(dupes).toEqual([]);
  });

  it("the belly ring's terse 'now' token resolves to 'ya', not 'ahora'", () => {
    // The sole i18n("now") caller is the belly-ring countdown, and the design
    // deliberately wants the terse 'ya' for the 48px ring. A stray duplicate
    // "now" would win by last-wins and show the longer 'ahora' instead.
    const nowVals = [...langBlock("es").matchAll(/"now":\s*"([^"]*)"/g)].map(
      (m) => m[1]
    );
    expect(nowVals).toEqual(["ya"]);
  });
});
