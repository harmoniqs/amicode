// AMICODE: data source for the approval card's transport (spec-20260727-164748 §9.5).
// Two routes: read the warrants the ledger holds, and mint one.
//
// SINGLE-WRITER DISCIPLINE (#212). Reading the ledger here is a plain file read, but
// WRITING goes through `amico ledger approve` — never an append from this process.
// amico-run is the ledger's only writer, which is what makes O_APPEND atomicity hold
// across the extension, the CLI, and this server. A "quick" append here would break
// that quietly and only under concurrency.
//
// WHY A ROUTE AT ALL. The card renders inside the webview, where no host context is
// reachable, so the app registers a bridge against these two routes (same shape as the
// vault browser's data path). It keeps the whole approval flow inside the fork — no
// extension command, no new IPC.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export interface WarrantRow {
  plan_hash: string
  bounds: Record<string, unknown>
  expires_at: string
  issued_by: string
  /** `solve` rows already recorded under this plan — the numerator for a
   *  max_solves bound. Counted from the SAME ledger pass, so it can never be a
   *  stale second counter (spec §4.5: the ledger is the count-things store). */
  solves_used: number
}

/** $AMICO_LEDGER override, else ~/.amico/ledger/runs.jsonl — must stay identical to
 *  amico-run's ledgerPath(), or the card would read a different file than the gate. */
export function ledgerPath(env: Record<string, string | undefined> = process.env): string {
  return env.AMICO_LEDGER || path.join(homedir(), ".amico", "ledger", "runs.jsonl")
}

/** Approval rows, newest last. A missing or partially-corrupt ledger yields whatever
 *  parsed — per-line tolerance, because one bad line must not blind the card to every
 *  other warrant. An empty result reads as "no warrant", which the card shows as
 *  pending; it never reads as approved. */
export function readWarrants(file: string = ledgerPath()): WarrantRow[] {
  if (!existsSync(file)) return []
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const out: Omit<WarrantRow, "solves_used">[] = []
  const solves = new Map<string, number>()
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as Record<string, unknown>
      // Count solves in the same pass — a second read could disagree with the first.
      if (rec.type === "solve") {
        if (typeof rec.plan_hash === "string") solves.set(rec.plan_hash, (solves.get(rec.plan_hash) ?? 0) + 1)
        continue
      }
      if (rec.type !== "approval") continue
      if (typeof rec.plan_hash !== "string" || typeof rec.expires_at !== "string") continue
      out.push({
        plan_hash: rec.plan_hash,
        bounds: typeof rec.bounds === "object" && rec.bounds !== null ? (rec.bounds as Record<string, unknown>) : {},
        expires_at: rec.expires_at,
        issued_by: typeof rec.issued_by === "string" ? rec.issued_by : "unknown",
      })
    } catch {
      /* one unparseable line must not hide the rest */
    }
  }
  return out.map((w) => ({ ...w, solves_used: solves.get(w.plan_hash) ?? 0 }))
}

export function warrantsBody(file: string = ledgerPath()): string {
  return JSON.stringify({ ok: true, warrants: readWarrants(file) })
}

export interface ApproveInput {
  plan_hash?: unknown
  bounds?: unknown
  expires_in?: unknown
}

/** Build the `amico ledger approve` argv. Exported for testing so the flag mapping is
 *  pinned without spawning anything. Only DECLARED bounds become flags — §5.1 rule 2
 *  refuses a launch needing a bound the warrant omits, so filling in a default here
 *  would silently widen the warrant the researcher thought they were granting. */
export function approveArgv(input: ApproveInput): string[] | { error: string } {
  const plan = typeof input.plan_hash === "string" ? input.plan_hash.trim() : ""
  if (!plan) return { error: "plan_hash is required" }
  const argv = ["ledger", "approve", "--plan-hash", plan]

  const b = typeof input.bounds === "object" && input.bounds !== null ? (input.bounds as Record<string, unknown>) : {}
  if (typeof b.max_solves === "number" && Number.isInteger(b.max_solves) && b.max_solves >= 1)
    argv.push("--max-solves", String(b.max_solves))
  if (typeof b.tier === "string" && b.tier.trim()) argv.push("--tier", b.tier.trim())
  if (b.max_size_class === "SMALL" || b.max_size_class === "MEDIUM") argv.push("--max-size-class", b.max_size_class)
  if (b.device === "none" || b.device === "ro" || b.device === "rw") argv.push("--device", b.device)
  if (typeof input.expires_in === "number" && Number.isInteger(input.expires_in) && input.expires_in >= 1)
    argv.push("--expires-in", String(input.expires_in))

  // Provenance: the ledger's only record of who approved. "user:ui" distinguishes a
  // button press from "user:cli", so an audit can tell them apart.
  argv.push("--issued-by", "user:ui")
  return argv
}

/** Mint a warrant by shelling the CLI. Never appends directly (see header). */
export function approveBody(input: ApproveInput): string {
  const argv = approveArgv(input)
  if ("error" in argv) return JSON.stringify({ ok: false, error: argv.error })
  const run = spawnSync("amico", argv, { encoding: "utf8" })
  if (run.error || run.status !== 0) {
    return JSON.stringify({
      ok: false,
      // stderr, not stdout: the CLI puts its refusal reason there, and it never
      // contains a credential (the approve verb takes none).
      error: (run.stderr || run.error?.message || `amico exited ${run.status}`).trim(),
    })
  }
  return JSON.stringify({ ok: true, stdout: run.stdout.trim() })
}
