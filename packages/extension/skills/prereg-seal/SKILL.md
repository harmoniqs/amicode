---
name: prereg-seal
description: Seal predictions and decision rules before a scan or solve — write them to a file, hash and stat it, and make the keys script refuse to run if a sealed file changed or any result file is older than the seal. Use before launching any scan, sweep, or batch whose acceptance keys are meant to falsify a prediction, and when writing the script that turns raw results into keys.
agents: [experimenter, analyzer, researcher]
surface: public
revision: 1
---

# prereg-seal — predictions that were really made before the data

A prediction only falsifies anything if it provably existed before the result. Prose in a spec ("rules fixed before scanning") is a claim; a **sealed file** is evidence: its bytes are hashed, its file times are recorded from one clock, and the script that computes the acceptance keys **refuses to run** if any sealed file has changed or any result file is older than the seal.

This is the mechanical half of the anti-gaming contract in `research`. It does not replace the independent corrector — it makes "I set the rule first" checkable by something other than the experimenter's word.

> **Status: draft.** `seal.py` below was run against the cases listed under *What was verified*. The pattern (hash a rules file before the scan, re-check it in the keys script) was hand-rolled by several casts in one campaign; the **file-time ordering check is new in this card** and has not yet been used on a real campaign.

## When to use

- Before **any scan, sweep, restart batch, or fit** whose outcome decides a key (PASS/FAIL, a named outcome, a scaling exponent).
- Whenever the rule involves a **choice that could be tuned after seeing data**: a fit window, a grid, a threshold, a normaliser, the space a regression is done in, which restarts count.

Skip it for runs whose output you will only inspect, never score.

## What goes in the seal

One or more small, human-readable files (JSON or markdown), written **before the first result file exists**:

1. **Decision rules** — thresholds, the exact fit (function, window, which space: e.g. R² of $1-F$ in the square-root space or the log space — one spec said "R² of $1-F=A(T^*-T)^2$" without naming the space, and the experimenter had to pre-declare one), the tolerance rule, and what counts as a counted restart.
2. **Numeric predictions** — the values the keys will be compared to.
3. **The outcome vocabulary, including the non-answers** — `NOT-RUN`, `UNDETERMINED`, `GUARD-TIMEOUT` are named outcomes with a defined key value, so a run that hit its wall-clock guard cannot be read as a pass or silently dropped.
4. **The grid or window derived from the prediction, set at seal time.** A spec that fixed a scan grid from one estimate and then sealed a prediction *outside* that grid made the key unresolvable by construction (a minimax predicted at 7.0 MHz against a grid that stopped short of it). Write the grid as "prediction ± k·spacing" and seal both together.
5. **The keys script itself** (and any module it imports that defines a fit helper), so the computation cannot drift between sealing and scoring.
6. **Hashes of upstream inputs** the prediction depends on (a pulse file, a contract, a cache) if they could be regenerated.

Do not put the results in the seal, and do not seal a file you will keep editing.

## The tool

`seal.py` (stdlib only). Save it next to the project's scripts.

```python
#!/usr/bin/env python3
"""seal.py write SEAL.json FILE...        hash + stat the pre-registration files, refuse to overwrite a seal
   seal.py check SEAL.json [RESULT...]   exit 1 if a sealed file changed, or any RESULT is older than the seal"""
import hashlib, json, os, sys, time

def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()

def write(seal, files):
    if os.path.exists(seal): sys.exit(f"refuse: {seal} already exists (a seal is written once)")
    rec = {"sealed_at_ns": time.time_ns(),          # one clock, UTC epoch; no hand-typed times
           "files": {p: {"sha256": sha(p), "size": os.path.getsize(p), "mtime_ns": os.stat(p).st_mtime_ns} for p in files}}
    if max(f["mtime_ns"] for f in rec["files"].values()) > rec["sealed_at_ns"]:
        sys.exit("refuse: a sealed file has an mtime in the future (clock skew)")
    json.dump(rec, open(seal, "w"), indent=1); os.chmod(seal, 0o444)
    print("sealed", len(files), "file(s) at", rec["sealed_at_ns"])

def check(seal, results):
    rec = json.load(open(seal)); bad = []
    for p, f in rec["files"].items():
        if not os.path.exists(p): bad.append(f"MISSING sealed file {p}")
        elif sha(p) != f["sha256"]: bad.append(f"CHANGED since seal: {p}")
    for r in results:
        if not os.path.exists(r): bad.append(f"MISSING result {r}")
        elif os.stat(r).st_mtime_ns < rec["sealed_at_ns"]: bad.append(f"PREDATES seal (not a blind result): {r}")
    for b in bad: print("SEAL VIOLATION:", b, file=sys.stderr)
    sys.exit(1 if bad else 0)

if __name__ == "__main__":
    c = sys.argv[1:2]
    if c == ["write"] and len(sys.argv) >= 4: write(sys.argv[2], sys.argv[3:])
    elif c == ["check"] and len(sys.argv) >= 3: check(sys.argv[2], sys.argv[3:])
    else: sys.exit(__doc__)
```

## The order of operations

1. Write the rules/predictions file(s) and the keys script. Review them (a critic or the spec gate reads *these*, not a summary).
2. `python3 seal.py write logs/prereg.seal.json prereg_rules.json prereg_pred.json keys.py`
3. **Only then** launch the scan, and make the launch conditional on the seal so the order cannot invert: `python3 seal.py check logs/prereg.seal.json && ./launch.sh scan_GA 5400 24 -- …` (see `detached-run`).
4. At scoring time, the **first thing the keys script does** is call the check over its own inputs:

   ```python
   import subprocess, sys, glob
   rc = subprocess.call([sys.executable, "seal.py", "check", "logs/prereg.seal.json", *glob.glob("results/*.json")])
   if rc: sys.exit("keys refused: seal violated (see stderr) — report NOT-SEALED, do not score")
   ```

   A violation is itself a reportable outcome (`NOT-SEALED`), not an error to route around. Never "fix" it by re-sealing: a seal is written once, and the tool refuses to overwrite it.
5. Keep the seal file with the run's artifacts; the verdict cites the seal's `sha256` entries and `sealed_at_ns`.

**Amendments are first-class, not edits.** If a rule must change after seeing data, write a *new* sealed file whose name and header say it is an amendment, list the old seal, and state what data had been seen when it was written. Results scored under an amendment are labelled as such.

## One clock

G1's self-reported stamps for one seal disagreed by minutes: a hand-typed `"written_local": "2026-11-06 19:24 box-local"` inside the JSON, against a `date` line of `Sat Nov 7 12:28:05 AM UTC` (= 19:28 local) in the `.txt` beside the hash. The tool therefore records `time.time_ns()` once and compares only against **file mtimes** from the same filesystem. Do not hand-type a time into a sealed file as if it were evidence; if you want a human-readable stamp, derive it from `sealed_at_ns` in UTC.

## What was verified

`seal.py` was run in a scratch directory (Python 3, Linux, 2026-11) against:

| case | expected | observed |
|---|---|---|
| `write` then `check` with no results | pass | exit 0 |
| second `write` on an existing seal | refused | exit 1, "already exists" |
| result file created after the seal | pass | exit 0 |
| result file with an mtime before the seal (`touch -d 2000-01-01`) | refused | exit 1, `PREDATES seal` |
| sealed rules file edited after sealing | refused | exit 1, `CHANGED since seal` |
| result path that does not exist | refused | exit 1, `MISSING result` |
| no / malformed arguments | usage | exit 1 |
| seal file permissions | read-only | `0444` |

## Limits (read these)

- **This catches accidents and honest drift, not an adversary.** `touch -d` forges an mtime; a file can be edited and re-sealed under another name. The independent corrector and human review remain the real gate.
- **mtime is a proxy for "produced after the seal".** A run *launched before* the seal that *finishes after* it passes the check — which is why step 3 ties the launch to the seal. Copies that preserve times (`cp -p`, `rsync -a`) can make a genuinely new result look old; the tool errs toward refusing.
- **It does not judge the rule.** An ill-posed key (a ratio whose denominator goes to zero on some lines, a statistic defined on the same data it is tested against, a fit that is definitional) seals just as well as a good one. Check rule quality at the spec gate (`deliberate`, *Spec-design checks*).
- It hashes bytes, not meaning: reformatting a sealed JSON file counts as a change.

## Provenance

fluxonium-cz research campaign (2026-11-06 … 11-07), proposal S-fcz-02: sealing was hand-rolled in wave 1 — a rules JSON plus a `sha256` text file (G1), a selection-rule JSON (H2c), `sha256_before/after` text files plus a config JSON (D2a) — and re-derived again in G1b and A2, whose results scripts re-hashed the sealed file before scoring. The campaign's own observation notes record the re-derivation cost ("would have saved about 3 steps"). The *file-time ordering check* and the single-clock rule are this card's additions; the clock-disagreement example is G1's (`prereg_rules.json` against `logs/prereg_sha256_before_scan.txt`).

## Related

- `research` — the standing anti-gaming contract this implements (keys from raw artifacts, STOP artifacts kept, interpretation waits for the analyzer).
- `deliberate` — the spec gate where rule quality is reviewed *before* sealing.
- `detached-run` — launch the scan after the seal; bounded and stoppable.
