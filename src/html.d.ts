// Wrangler's `rules: [{ type: "Text", globs: ["**/*.html"] }]` imports .html
// files as strings; this teaches TypeScript the same.
declare module "*.html" {
  const content: string;
  export default content;
}
