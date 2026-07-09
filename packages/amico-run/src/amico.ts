// `amico` — the shared CLI verb router (issue #108, spec-20260708-112732 §7.3). Generalizes
// the `amico-run` bin: the same launch path (`amico run <script.jl> --spec …`) plus the
// spine bookkeeping verbs and the `mcp-serve` facade. ONE binary, invoked via bash by both
// runtimes (Claude Code + opencode) AND directly by the deterministic harness / cron / CI /
// Julia.
//
// B1 SCOPE: `run` / `resolve` / `sandbox` delegate VERBATIM to the existing amico-run launch
// path (src/launch.ts): `amico <verb> <args>` is exactly `amico-run <equivalent-args>`, so
// there is no behavior fork and the amico-run test suite still covers the real bodies. The
// spine verbs (catalog/vault/device/note) are STUB seams (see verbs.ts) — routing works
// today; real bodies land in later spine slices.
// B5 SCOPE (issue #112): `mcp-serve` is now REAL — it stands up an MCP stdio transport that
// exposes the same spine verbs as MCP tools (see mcp_serve.ts). One impl, two transports.
import { launch } from "./launch.js";
import { SPINE_VERBS } from "./verbs.js";
import { serve } from "./mcp_serve.js";

function usage(): string {
  const rows: [string, string][] = [
    ["run <script.jl> [--spec <s.json>] […]", "launch a solve — the amico-run launch path (delegates verbatim)"],
    ["resolve --platform <p> --kind <k> --size <n>", "tier resolution → JSON (amico-run subcommand)"],
    ["sandbox <workspace-dir> --packages A,B,…", "generate a per-problem Julia env (amico-run subcommand)"],
    ...SPINE_VERBS.map((v) => [`${v.name} …`, `${v.summary} [stub → ${v.slice}]`] as [string, string]),
    ["mcp-serve [--list]", "serve the spine verbs as MCP tools over stdio (optional facade; --list = mapping only)"],
    ["--help, -h", "show this verb surface"],
  ];
  const width = Math.max(...rows.map(([u]) => u.length));
  const lines = rows.map(([u, d]) => `  amico ${u.padEnd(width)}  ${d}`);
  return `usage:\n${lines.join("\n")}`;
}

export async function main(argv: string[]): Promise<number> {
  const head = argv[0];
  const rest = argv.slice(1);

  if (!head || head === "--help" || head === "-h") {
    console.log(usage());
    return head ? 0 : 64; // explicit --help is success; a bare `amico` is a usage error
  }

  // spine bookkeeping verbs (catalog/vault/device/note) — B1 stubs, print intent + exit 0.
  const verb = SPINE_VERBS.find((v) => v.name === head);
  if (verb) {
    const { json, code } = await verb.run(rest);
    console.log(JSON.stringify(json));
    return code;
  }

  switch (head) {
    // ── delegate verbatim to the existing amico-run launch path ──
    // `amico run <args>`      ≡ `amico-run <args>`            (launch / --spec gate)
    // `amico resolve <args>`  ≡ `amico-run resolve <args>`    (tier resolution subcommand)
    // `amico sandbox <args>`  ≡ `amico-run sandbox <args>`    (env generation subcommand)
    case "run":
      return launch(rest);
    case "resolve":
      return launch(["resolve", ...rest]);
    case "sandbox":
      return launch(["sandbox", ...rest]);

    case "mcp-serve":
      return serve(rest);

    default:
      console.error(`amico: unknown verb "${head}"\n${usage()}`);
      return 64;
  }
}

main(process.argv.slice(2)).then(
  (c) => {
    process.exitCode = c;
  },
  (e) => {
    // Any unexpected throw is an orchestrator fault, not a solve failure → 64.
    console.error(`amico: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    process.exitCode = 64;
  },
);
