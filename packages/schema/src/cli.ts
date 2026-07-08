// amico-validate — validate an amico config/artifact file against the shared
// schema set. A thin CLI over @amicode/schema's validate() — NO parallel
// validation logic. Exit 0 = valid, 64 = invalid or usage error (mirrors
// amico-run's config-error exit convention, Q85).
import { validateFile, kindForFilename, SCHEMA_KINDS, type SchemaKind } from "./index.js";

const USAGE = `usage: amico-validate <file> [--schema <kind>]
  <file> role is inferred from its name (run.toml, result.toml, lab.toml, FINISHED);
  pass --schema for solvespec / catalog-entry or any non-standard filename.
  kinds: ${SCHEMA_KINDS.join(", ")}
exit: 0 valid · 64 invalid or usage error`;

export function main(argv: string[]): number {
  let file: string | undefined;
  let schema: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(USAGE);
      return 0;
    }
    if (a === "--schema") {
      schema = argv[++i];
      if (schema === undefined) {
        console.error(`amico-validate: --schema requires a value\n${USAGE}`);
        return 64;
      }
    } else if (a.startsWith("-")) {
      console.error(`amico-validate: unknown flag ${a}\n${USAGE}`);
      return 64;
    } else if (file !== undefined) {
      console.error(`amico-validate: multiple files given\n${USAGE}`);
      return 64;
    } else {
      file = a;
    }
  }
  if (file === undefined) {
    console.error(`amico-validate: no file given\n${USAGE}`);
    return 64;
  }

  const inferred = schema ?? kindForFilename(file);
  if (inferred === undefined) {
    console.error(`amico-validate: cannot infer schema for ${file} — pass --schema <${SCHEMA_KINDS.join("|")}>`);
    return 64;
  }
  if (!SCHEMA_KINDS.includes(inferred as SchemaKind)) {
    console.error(`amico-validate: unknown schema "${inferred}" (kinds: ${SCHEMA_KINDS.join(", ")})`);
    return 64;
  }
  const kind = inferred as SchemaKind;

  const r = validateFile(file, kind);
  if (r.ok) {
    console.log(`OK ${file} (${kind})`);
    return 0;
  }
  console.error(`INVALID ${file} (${kind}):`);
  for (const e of r.errors) console.error(`  ${e}`);
  return 64;
}

process.exit(main(process.argv.slice(2)));
