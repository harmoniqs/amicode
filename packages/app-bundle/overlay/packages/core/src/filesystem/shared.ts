// filesystem/shared.ts — the cycle-break module (2026-10-05, the #775/#1709 wedge).
//
// filesystem.ts imports ./filesystem/search at module init — its node's deps
// array captures FileSystemSearch.node — and search.ts imported the FileSystem
// namespace BACK from ../filesystem. Under bun/esbuild module-cycle semantics
// that capture froze to undefined (or threw TDZ, depending on entry order),
// which meant:
//   - EVERY per-directory location build crashed with an anonymous
//     "undefined is not an object (evaluating 'a.name')" TypeError inside the
//     layer walk (caught and swallowed as "failed to load project references"),
//   - the half-built per-location layer (fresh-compiled watchers, snapshot
//     trackers, LLM machinery) leaked on every catch — at ~8+ parallel
//     sessions the leak rate wedged the engine: RSS to 2.5-7GB, main thread
//     spinning, TCP accepts / HTTP silent. The 2026-09-03/04 + 2026-10-03/04
//     wedge series, solved.
//
// Both sides now import from THIS module; neither imports the other. The
// shapes are the schema package's (cycle-free) plus the two input classes that
// used to live in filesystem.ts.

import { Schema } from "effect"
import { PositiveInt, RelativePath } from "../schema"

export { Entry, Match, Submatch, FindInput } from "@opencode-ai/schema/filesystem"

export class GlobInput extends Schema.Class<GlobInput>("FileSystem.GlobInput")({
  pattern: Schema.String,
  path: RelativePath.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
}) {}

export class GrepInput extends Schema.Class<GrepInput>("FileSystem.GrepInput")({
  pattern: Schema.String,
  path: RelativePath.pipe(Schema.optional),
  include: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
}) {}
