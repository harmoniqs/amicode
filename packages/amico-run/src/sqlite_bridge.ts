// sqlite_bridge.ts — the sessions verb's SQLite access over python3's stdlib
// sqlite3 (D4 slice 3, #795; CI portability fix).
//
// Why python3 and not node:sqlite: the repo's CI pins node 20 (ci.yml) and the
// engines say >= 20, but node:sqlite only exists on node >= 22.5 — a node:sqlite
// driver silently breaks the verb (and its tests) on the repo's own CI node.
// The store's OTHER reader already uses python3 stdlib sqlite3 (the open-threads
// skill: file:<db>?mode=ro, timeout=5), and AMICO_PYTHON→python3 is the
// product's existing interpreter resolution (pasqal_launch.ts). Zero new
// dependencies; the write path runs through the real sqlite engine (proper
// locking/commit), never a load-whole-file rewrite.
//
// Shape: ONE python3 invocation per verb operation, statements batched, JSON
// over stdio. `ro` opens READ-ONLY (the open-threads discipline: the hub owns
// the live DB); `rw` opens read-write and commits at the end.

import { spawnSync } from "node:child_process";

export interface BridgeStatement {
  sql: string;
  params?: unknown[];
}

export interface BridgeStatementResult {
  rows: Record<string, unknown>[];
  changes: number;
}

export interface BridgeResult {
  results: BridgeStatementResult[];
}

const PYTHON_SCRIPT = `
import json, sqlite3, sys

req = json.load(sys.stdin)
db = req["db"]
if req["mode"] == "rw":
    con = sqlite3.connect(db, timeout=5)
else:
    con = sqlite3.connect("file:" + db + "?mode=ro", uri=True, timeout=5)
try:
    results = []
    for st in req["statements"]:
        cur = con.execute(st["sql"], st.get("params", []))
        rows = []
        if cur.description is not None:
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        results.append({"rows": rows, "changes": max(cur.rowcount, 0)})
    if req["mode"] == "rw":
        con.commit()
    json.dump({"results": results}, sys.stdout)
finally:
    con.close()
`;

export class SqliteBridgeError extends Error {}

export function sqliteBatch(
  dbPath: string,
  mode: "ro" | "rw",
  statements: BridgeStatement[],
  env: NodeJS.ProcessEnv = process.env,
): BridgeResult {
  const py = env.AMICO_PYTHON && env.AMICO_PYTHON.trim() !== "" ? env.AMICO_PYTHON : "python3";
  const res = spawnSync(py, ["-c", PYTHON_SCRIPT, "--"], {
    input: JSON.stringify({ db: dbPath, mode, statements }),
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.error) {
    throw new SqliteBridgeError(
      `could not run ${py}: ${res.error.message} — install Python 3, or set AMICO_PYTHON to your interpreter`,
    );
  }
  if (res.status !== 0) {
    throw new SqliteBridgeError(`sqlite bridge failed (exit ${res.status}): ${(res.stderr || res.stdout || "").trim()}`);
  }
  let parsed: BridgeResult & { error?: string };
  try {
    parsed = JSON.parse(res.stdout) as BridgeResult & { error?: string };
  } catch {
    throw new SqliteBridgeError(`sqlite bridge returned unparseable output: ${(res.stdout || "").slice(0, 200)}`);
  }
  if (parsed.error) throw new SqliteBridgeError(parsed.error);
  return parsed;
}
