/**
 * Bun preload plugin: mock Vite-specific ?worker&url imports.
 *
 * Vite transforms `import Url from "./foo.ts?worker&url"` into a URL string
 * at build time. Bun's test runner doesn't understand this suffix. This plugin
 * intercepts any import ending in `?worker&url` and returns a dummy string,
 * so modules that import worker URLs can load in tests without crashing.
 *
 * The Worker constructor will receive the dummy string and fail, which is
 * expected — getWorker() catches the error and returns null, falling back
 * to lezer-only highlighting in tests.
 */
import { plugin } from "bun"

plugin({
  name: "vite-worker-url-mock",
  setup(build) {
    build.onResolve({ filter: /\?worker&url$/ }, (args) => {
      return { path: args.path, namespace: "vite-worker-url-mock" }
    })
    build.onLoad({ filter: /.*/, namespace: "vite-worker-url-mock" }, () => {
      return { contents: 'export default "mock-worker-url"', loader: "js" }
    })
  },
})
