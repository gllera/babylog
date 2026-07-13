// Reach into src/app.html's single inline ES5 script. The belly kernel/ring
// code has no build step and no exports; tests slice named top-level
// functions out of the file by brace counting and rebuild them inside a
// `new Function` sandbox with their few DOM/settings-coupled dependencies
// injected. Brace counting is safe here: the sliced functions' only braces
// inside string literals are balanced i18n templates like "{n}".
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../src/app.html", import.meta.url), "utf8");

/** Source of the top-level `function name(...) {...}` declaration. */
export function fnSource(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in app.html`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

/** Every top-level FG_/fg/BR_ `var` declaration line, in file order.
 *  Top-level script code in app.html is indented exactly 4 spaces;
 *  function bodies are 6+, so the anchor excludes locals. */
export function varLines(): string {
  return html
    .split("\n")
    .filter((l) => /^    var (FG_|fg[A-Z]|BR_)/.test(l))
    .join("\n");
}

/** The digestion kernel, DOM-free. `nightAt` is injected (default:
 *  everything is daytime). Fresh sandbox per call — memoization state
 *  (fgMedFor/fgMedMl etc.) never leaks between tests. */
export function kernel(nightAt: (tMs: number) => boolean = () => false): any {
  const src = [
    varLines(),
    fnSource("fgQuantile"),
    fnSource("medFeedMl"),
    fnSource("fgKappa"),
    fnSource("fgSpanMs"),
    fnSource("remFrac"),
    fnSource("digestedFrac"),
    fnSource("digSumMl"),
    fnSource("fullnessAt"),
    fnSource("hungerCalib"),
    fnSource("calibKappa0"),
    fnSource("fgForecastErr"),
    "return { fgQuantile, medFeedMl, fgKappa, fgSpanMs, remFrac, digestedFrac," +
      " digSumMl, fullnessAt, hungerCalib, calibKappa0, fgForecastErr," +
      " FG_T_HALF_MS, FG_BETA, FG_VOL_P, FG_EPS, FG_KAPPA0_MS, FG_TRUNC," +
      " FG_MED_FALLBACK, FG_HGR_MIN_N };",
  ].join("\n");
  return new Function("nightAt", src)(nightAt);
}
