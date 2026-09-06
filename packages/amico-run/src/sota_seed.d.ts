// Type the data-as-import seam (#820): resources/*.toml import as their text
// content under both runtimes — esbuild (`.toml: "text"` loader, so the
// self-contained bins carry the canonical seed) and vitest (the matching
// toml-as-text plugin). One copy of the data, two runtimes.
declare module "*.toml" {
  const text: string;
  export default text;
}
