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

  it("every markup data-i18n key (incl. -placeholder/-title/-aria-label variants) has an ES translation", () => {
    // data-i18n="..." and its data-i18n-<attr> variants (e.g.
    // data-i18n-aria-label="...") are fully literal (unlike dynamic i18n(...)
    // call sites), so every value used in the markup must resolve — a typo'd
    // or relocated key would otherwise silently fall back to the raw English
    // text with no error anywhere.
    const dict = new Set(keysOf(langBlock("es")));
    const used = [
      ...html.matchAll(/\bdata-i18n(?:-[a-z-]+)?="((?:[^"\\]|\\.)*)"/g),
    ].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    const missing = used.filter((k) => !dict.has(k));
    expect(missing).toEqual([]);
  });

  it("every literal i18n(\"...\") call-site key has an ES translation", () => {
    // Dynamic i18n(...) calls often take a computed key (a variable, or a
    // bare ternary of two literals, e.g. i18n(cond ? "a" : "b")) — this
    // deliberately does not match either, since the key isn't fixed at the
    // call site's first argument, so there's nothing static to check. A bare
    // ternary is the one remaining documented gap (plural()'s ternary is
    // covered separately below, since its two keys ARE literal at its own
    // call site). But a literal-string i18n(...) argument is just as fixed as
    // a data-i18n attribute and just as brittle: a typo'd/relocated key
    // silently falls back to raw English with no error anywhere. `\s*`
    // tolerates the call being wrapped across lines (i18n(\n  "...", {...})).
    const dict = new Set(keysOf(langBlock("es")));
    const used = [...html.matchAll(/i18n\(\s*"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => m[1]
    );
    expect(used.length).toBeGreaterThan(0);
    const missing = used.filter((k) => !dict.has(k));
    expect(missing).toEqual([]);
  });

  it("every plural(n, singularKey, pluralKey) call-site key pair has an ES translation", () => {
    // plural(n, singularKey, pluralKey) resolves to i18n(n === 1 ?
    // singularKey : pluralKey, ...) — a ternary-on-variables call the
    // i18n(...) check above deliberately can't see (its key isn't a literal
    // at that call site). But at the plural() call site itself both keys ARE
    // fully literal, so they're just as fixed and just as brittle as any
    // other checked key: a typo'd/relocated key would silently show English
    // in an age string with no error anywhere.
    const dict = new Set(keysOf(langBlock("es")));
    const used = [
      ...html.matchAll(
        /\bplural\(\s*[^,]+,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g
      ),
    ].flatMap((m) => [m[1], m[2]]);
    expect(used.length).toBeGreaterThan(0);
    const missing = used.filter((k) => !dict.has(k));
    expect(missing).toEqual([]);
  });
});
