# H0b spike: upstream V1→V2 importer on a copy of the hub database

- Issue: harmoniqs/amicode#2047 (part of #2043, spec section H0, ADR 0039)
- Date: 2026-11-01
- Status: **pre-registered** (criteria below were committed before the first importer run; results are appended in later commits)

## Questions

1. What does upstream's V1→V2 importer actually do to a real hub database: which rows it imports, which it skips or degrades, and what it deletes?
2. Does it leave our custom (non-upstream) tables alone?
3. How long does it take and how much memory does it use on a copy of the real database?
4. Is it idempotent on a second run?
5. Does it really do nothing under Node?
6. Can the `event` table be archived before the import and compared afterwards?

## Procedure (fixed in advance)

All steps run against copies only. The live database `~/.local/share/opencode/opencode.db` is opened only with `file:...?mode=ro` and read by the SQLite online-backup API at `nice -n 19 ionice -c3`. No unit is restarted, no process I did not start is signalled, nothing under `~/.amico/server` or `~/.config/systemd` is touched. Everything that could open a database runs with temporary `XDG_*` directories and `OPENCODE_DB` pointing at the copy.

1. Record `ls -la` of the live data directory before and after.
2. Copy: Python `sqlite3` backup API from the read-only handle to `/tmp/opencode/h0b/hubcopy.db`; record wall time, source size, copy size. Make a pristine second copy (`cp --reflink=auto`).
3. Dump the source schema and per-table row counts to `raw/source-counts.json`.
4. Check out upstream at commit `12f7e1b59a`, `bun install`.
5. Read `packages/core/src/database/v1-migration.bun.ts` and the migration set; write the smallest bun script that builds the Database layer on the copy and runs the V1 migration to completion; run it under `/usr/bin/time -v` and `nice -n 19` with logs in `raw/import.log`.
6. Capture per-table counts afterwards (`raw/after-counts.json`).
7. Run the script a second time on the imported copy (idempotence). Run a fresh pass on the pristine copy under Node, if cheap.
8. Compare table lists and counts source against after; derive loss counts from the log and from direct queries on source data (unrecognised part types, non-`data:` file attachments, agent permissions).

## Pass / inform criteria (written before the first run)

These are inform-type measurements with explicit expectations, not a pass/fail on the importer itself. The spike passes when every item below is answered with a number or an explicit "not determinable, because …".

| id | criterion | expectation recorded now |
|---|---|---|
| a | Every table in the copy is listed with its source row count | complete list incl. custom tables |
| b | After import: counts of sessions, messages, parts imported vs source | sessions and messages ≈ equal to source rows that the importer can read; parts ≤ source |
| c | Deleted/skipped/lossy: `event` table deleted; unrecognised parts skipped; non-`data:` file attachments replaced by text; agent permissions NULLed. Each with a count | counts obtained for each of the four, or a stated reason a count is not determinable |
| d | Custom (non-upstream) tables: named, and whether untouched (same row count and same content hash) after import | expectation: untouched, since the importer knows nothing of them; contradicted if any count or hash differs |
| e | Wall time and peak RSS (`/usr/bin/time -v`) | recorded, extrapolated to 9 GB in the decision |
| f | Second run on the imported copy: no further change in any table count | expectation: idempotent (no-op); if not, the difference is listed |
| g | Node vs Bun: confirm by reading that `#v1-migration` maps to a no-op under Node; run it if cheap | expectation: Node leaves the copy unchanged |

Decision section (written after the run) must answer: (i) can the `event` table be archived before import and compared after, with the exact method; (ii) is the importer safe to run at cutover on a copy; (iii) which custom tables need our own migration path; (iv) estimated cutover duration on the real 9 GB database.

Acceptance criteria of #2047 map as: note lists every table with source and imported counts (a, b); every skipped or lossy item with custom tables called out (c, d); event archiving stated (decision i); live database and units byte-for-byte unmodified afterwards (verified by the directory listing and the main file's mtime/size/hash-of-header comparison, see Results).

## Results

_Not yet run._
