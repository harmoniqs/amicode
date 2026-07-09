// Raw SVG text imports (esbuild loader: {".svg": "text"}, see esbuild.config.mjs)
// — lets icon components inject a canonical .svg file's markup directly
// instead of hand-duplicating its path data as a separate TS literal.
declare module "*.svg" {
  const content: string;
  export default content;
}
