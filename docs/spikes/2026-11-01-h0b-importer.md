# H0b spike: upstream V1→V2 importer on a copy of the hub database

- Issue: harmoniqs/amicode#2047 (part of #2043, spec section H0, ADR 0039)
- Date: 2026-11-01
- Status: **run complete**. The criteria below were committed (8327a0f8) before the first importer run; the Results and Decision sections were appended afterwards. Nothing in the pre-registered text was edited after the run except this status line.

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

Raw outputs live beside this note in `2026-11-01-h0b-importer/` (counts, per-table hashes, loss queries, timing, condensed logs, the driver script and the Python helpers). Environment: upstream `12f7e1b59a`, Bun 1.4.2, Node 22.23.2, Linux, machine load 5 to 14 on 24 cores, every step under `nice -n 19`.

### What was copied, and how

- Source: the live hub database, 8,991,510,528 bytes (9.0 GB) when the copy started; WAL mode with three engine shards writing.
- Method: Python `sqlite3` backup API, one step (`pages=-1`, so a single consistent read snapshot), from a `file:...?mode=ro` handle, at `nice -n 19 ionice -c3`. Wall time **14.2 s**; copy 8,992,387,072 bytes. The handle was open for those 14 s and then closed. No retry was needed.
- Live directory listing before and after (`live-dir-listing.md `live-dir-listing.md the only differences are the live `opencode.db` itself, which the running engines keep writing (8,991,510,528 to 9,003,069,440 bytes over about 14 minutes), and two harness directories (`external-diff`, `tool-output`) that belong to this session's tooling. The WAL and SHM sizes are identical. No file of ours was created in that directory; no unit was touched.
- A pristine second copy was made for repeatability and every run below was done on a further copy of it.

### (a) Every table, source and after (rows)

`src` is the pristine copy of the hub database. `bun` is after one importer run under Bun. `node` is a fresh copy run through the same driver under Node (see (g)). `-` means the table does not exist.

| table | src | bun | node | note |
|---|---:|---:|---:|---|
| account | 0 | 0 | 0 | |
| account_state | 0 | 0 | 0 | |
| blob | - | 0 | 0 | created by upstream schema migration |
| blob_ref | - | 0 | 0 | created |
| control_account | 0 | 0 | 0 | |
| credential | 0 | 0 | 0 | |
| data_migration | 0 | - | - | **dropped** by migration `20260804233008_loose_psylocke` |
| event | 2,618,393 | **0** | 2,618,393 | **emptied by the importer** (Bun only) |
| event_sequence | 3,282 | 3,420 | 3,282 | every old row's `seq` rewritten; 138 rows added |
| instruction_blob | - | 0 | 0 | created |
| instruction_entry | - | 0 | 0 | created |
| instruction_state | - | 0 | 0 | created |
| job | - | 0 | 0 | created |
| kv | - | 1 | 0 | created; holds `migration.v1-v2` state |
| message | 184,167 | 184,167 | 184,167 | legacy V1, untouched |
| migration | 45 | 66 | 66 | 21 upstream migrations applied |
| part | 735,801 | 735,801 | 735,801 | legacy V1, untouched |
| permission | 30 | 30 | 30 | |
| project | 4 | 14 | 4 | importer adds resolved owners and `global` |
| project_directory | 42 | 42 | 42 | |
| provider_permission | 0 | 0 | 0 | ours |
| runtime_busy | 22 | 22 | 22 | ours |
| runtime_pending | 77 | 77 | 77 | ours |
| runtime_session_owner | 23 | 23 | 23 | ours |
| schedule | - | 0 | 0 | created |
| session | 3,420 | 3,420 | 3,420 | legacy V1, untouched |
| session_context_epoch | 1 | - | - | **dropped** by `20260804233008` |
| session_inbox | - | 0 | 0 | created |
| session_input | 1 | - | - | **dropped** by `20260804233008` |
| session_lineage | 1,314 | 1,314 | 1,314 | ours |
| session_lineage_origin | 0 | 0 | 0 | ours |
| session_message | 637 | **186,909** | **0** | old rows deleted by schema migration (both runtimes); Bun then fills |
| session_part | - | 0 | 0 | created, unused by the importer |
| session_receipt | 0 | 0 | 0 | ours |
| session_receipt_assessment | 0 | 0 | 0 | ours |
| session_receipt_operation | 0 | 0 | 0 | ours |
| session_share | 0 | 0 | 0 | legacy V1 |
| session_v2 | - | **3,420** | 0 | created by schema migration; filled by the importer |
| todo | 1,775 | 1,775 | 1,775 | legacy V1 |
| workspace | 0 | 0 | 0 | columns replaced (see below) |
| worktree | - | 42 | 42 | created by a migration and populated (42 rows, same count as `project_directory`) |

Post-import integrity on the Bun copy: `PRAGMA quick_check` = `ok`; `PRAGMA foreign_key_check` returned no rows.

### (b) Imported counts

| | source | after (Bun) |
|---|---:|---:|
| sessions | 3,420 (`session`) | 3,420 (`session_v2`); 0 missing |
| messages | 184,167 (`message`) | 186,909 (`session_message`) |
| parts | 735,801 (`part`) | no parts table in V2; folded into message JSON, see below |

The 186,909 V2 messages are: 176,316 assistant, 7,332 user, 2,799 system, 406 synthetic, 56 compaction. 2,806 of those ids are new (2,799 `system` tool-rename notices and 7 `synthetic` splits). 64 V1 message ids have no V2 row (56 are the assistant summaries merged into the 56 compaction messages; the other 8 are not explained by a warning, since the importer silently returns nothing for incomplete compactions and subtask-only messages, and this spike did not trace them individually). So messages are not one to one.

Where the 735,801 V1 parts went:

| V1 part type | source | in V2 |
|---|---:|---|
| tool | 204,812 | 204,812 tool items in assistant content (202,677 completed; 2,135 error, of which **426 were `running` or `pending` and were rewritten as an interrupted error**) |
| reasoning | 110,672 | 110,633 reasoning items (39 not carried; not traced individually, most likely those owned by merged summary messages) |
| text | 68,521 | 60,721 assistant text items; user text goes to `user.text`; 419 synthetic user texts become 406 `synthetic` messages |
| file | 109 | 108 user-file attachments in 95 messages; 1 was non-`data:` and became a text note |
| step-start | 176,033 | not kept as parts; 87,631 assistant messages carry a `snapshot` start/end, from 87,667 step-starts with a snapshot |
| step-finish | 175,293 | not kept as parts; contributes only the end snapshot |
| patch | 295 | contributes `snapshot.files` only |
| compaction | 64 | 56 compaction messages (8 dropped) |
| skill | 2 | **skipped** (the only two `invalid-part` warnings of the whole run) |

### (c) Deleted, skipped, lossy

| item | count | evidence |
|---|---:|---|
| `event` table emptied (Bun importer, first run only) | **2,618,393** rows, 4.88 GB of `data`, 9 event types, 3,282 aggregates | `after-counts.json`, `loss.json` |
| event types lost | `message.part.updated.1` 1,719,334; `message.updated.1` 704,064; `session.updated.1` 190,750; `session.created.1` 3,278; `session.next.model.switched.1` 336; `message.removed.1` 329; `session.next.agent.switched.1` 300; `session.next.prompted.1` 1; `session.next.prompt.admitted.1` 1 | `loss.json` |
| unrecognised parts skipped | **2** (`skill`), logged as `Skipped V1 migration row` / `invalid-part`; **no** other warnings, no orphan parts, no invalid messages | `import-run1.condensed.log` |
| non-`data:` file attachments replaced by text | **1** (a `file:` URL in a user message), now `[Attachment unavailable after migration: ...]` | `loss.json` |
| agent permissions NULLed in `session_v2.permission` | **2,342** sessions had one; V2 holds 0. The legacy `session.permission` still has all 2,342 | `loss.json` |
| tool calls frozen mid-flight rewritten as interrupted errors | 426 (411 running, 15 pending) | `parts.json` |
| old V2-lineage rows in `session_message` deleted | 637 rows in 317 sessions (336 `model-switched`, 300 `agent-switched`, 1 `user`); none survive | schema migration, `loss.json` |
| `session_input` and `session_context_epoch` dropped | 1 row each (one session, `steer` input) | `20260804233008` |
| per-session cost and token totals recomputed from assistant messages | cost sum 15,422.65 (legacy) vs 15,424.94 (V2); input tokens 5,822,015,107 vs 5,822,434,629 | `loss.json` |
| sessions moved to a different project by directory resolution | **1,035** of 3,420 (`project_id` differs from the legacy row); 10 projects added; `directory` unchanged for all | `loss.json` |
| `event_sequence` | all 3,282 old `seq` values replaced by the V2 message watermark; 138 aggregates added; `owner_id` set NULL (none were set) | `loss.json` |
| `workspace` table shape replaced | 0 rows, so no data lost; columns `type, name, branch, directory, extra, project_id, time_used` dropped, `provider, binding, created_at, last_used_at` added | `table-diff.json` |
| `session.directories` (our column) | 0 populated rows; `session_v2` has no such column | `loss.json` |

### (d) Custom (non-upstream) tables

Method: bootstrap a fresh upstream database with the same Database layer, list its tables, subtract. The legacy V1 tables below belong to upstream's old schema and were also untouched.

| table | rows | untouched after import? |
|---|---:|---|
| session_lineage | 1,314 | yes, order-independent row hash identical |
| session_lineage_origin | 0 | yes |
| session_receipt | 0 | yes |
| session_receipt_assessment | 0 | yes |
| session_receipt_operation | 0 | yes |
| runtime_busy | 22 | yes |
| runtime_pending | 77 | yes |
| runtime_session_owner | 23 | yes |
| provider_permission | 0 | yes |
| legacy V1: session, message, part, todo, session_share | 3,420 / 184,167 / 735,801 / 1,775 / 0 | yes, hash identical (no column added or removed) |

Dropped, not untouched: `data_migration`, `session_context_epoch`, `session_input` (upstream's schema migration, see (c)).

Two things the importer does not know about our tables: `session_lineage`, `session_receipt` and `session_receipt_operation` have a foreign key to the **legacy `session(id)`** table, which upstream V2 never writes. Rows for sessions created after the cutover live only in `session_v2`, so inserts into these tables for new sessions would violate the key while `foreign_keys = ON` (this was not exercised here). Our seven hub-only migration ids stay in the `migration` table; upstream ignores ids it does not know. The "mutation ledger" named in ADR 0039 has no table in this database.

### (e) Wall time and peak RSS

| run | wall | peak RSS | notes |
|---|---:|---:|---|
| Copy (backup API) | 14.2 s | n/a | `nice -n 19 ionice -c3` |
| Bun, first run on the 9.0 GB copy | **88.9 s** | **639 MB** | the 21 schema migrations took 0 to 2 ms each; the rest is the session loop; 69 % CPU |
| Bun, second run on the imported copy | 0.60 s | 227 MB | status already `completed` |
| Bun, third run with the `kv` state row deleted | 57.9 s | 640 MB | re-imports every session |
| Node, fresh copy | 0.48 s | 218 MB | importer is a no-op |
| Event archive, `CREATE TABLE AS` | 11.6 s | n/a | 5.65 GB archive file |
| Archive verification (order-independent row hash, both sides) | 46.9 s | n/a | |

### (f) Idempotence

- Second run on the imported copy: status `completed`, importer returns immediately. All 38 shared tables have identical row counts and identical order-independent row hashes before and after (`table-diff-run2.json`).
- Stronger test: delete the `migration.v1-v2` row from `kv` and run again. The importer redoes every session in 57.9 s and the result is **identical** to the first import in every table except `kv` itself (timestamps) (`table-diff-rerun.json`). Synthetic message ids are deterministic. Reading the code shows the cost of that: for each session it deletes every `session_message` row and reinserts, so a re-run after V2 has started writing **destroys V2 history for imported sessions**.
- The `completed` state is sticky: V1 rows written after it is set are never imported.

### (g) Node versus Bun

- Read: `packages/core/package.json` maps `#v1-migration` to `v1-migration.bun.ts` under the `bun` condition and to `v1-migration.noop.ts` under `node`, `workerd` and `default`. Confirmed by `import.meta.resolve('#v1-migration')`: Node resolves the `noop` file, Bun resolves the `bun` file. The no-op returns `{status:"completed"}`.
- Run: Node 22.23 cannot load the workspace TypeScript sources (strip-only mode rejects parameter properties), so the driver was bundled with `bun build --target node --conditions node --external jsonc-parser` and run with `node`. That ran to completion in 0.48 s with status `completed` and no import.
- The pre-registered expectation "Node leaves the copy unchanged" was **wrong**. Under Node the Database layer still applies the 21 schema migrations, so on the copy: `session_message` ends at 0 rows (its 637 rows are dropped), `session_input` and `session_context_epoch` are dropped, `session_v2` is created and empty, `event` stays at 2,618,393, `kv` is empty. Booting V2 under Node on this database therefore both loses data and imports nothing.

## Decision

**(i) Can the event table be archived before import and compared afterwards?** Yes. Do it before the first V2 open, because the schema migrations run on open under either runtime. Exact method, tested on the copy:

```python
c = sqlite3.connect("file:SNAPSHOT.db?mode=ro", uri=True)   # the cutover snapshot, never the live file
c.execute("attach database ? as arc", ("event-archive.db",))
c.execute("create table arc.event as select * from main.event")
c.execute("create table arc.event_sequence as select * from main.event_sequence")
c.commit()
```

That took 11.6 s and produced a 5.65 GB file with 2,618,393 `event` rows and 3,282 `event_sequence` rows, whose order-independent SHA-256 row hashes equal the source's (`archive.json`). Keeping the pre-import snapshot file itself is the simpler alternative; the archive is the form that can outlive the snapshot. "Compare afterwards" means three checks that are mechanical: `event` has 0 rows after import; the archive hash still matches the snapshot; and every one of the 3,282 archived aggregates still has an `event_sequence` row after import (true here, 0 missing) with a changed `seq` (true for all). Not done in this spike: reconciling archived event contents against V2 messages per session. The archive keeps the V1 five-column shape; V2's `event` table has an extra `created` column, so the archive cannot be loaded back as-is.

**(ii) Is the importer safe to run for the cutover on a copy?** Yes, on this evidence: exit 0, two warnings (both the unsupported `skill` part), integrity and foreign-key checks clean, legacy and custom tables hash-identical, 3,420 of 3,420 sessions imported, second run a no-op, forced re-run reproduces the same result. It is not safe to treat as reversible on the live file, and four conditions apply:
1. A snapshot is mandatory; the schema migrations alone drop three tables and 637 rows even under Node.
2. Quiesce all V1 writers before the run. The `completed` marker means later V1 writes are never imported, and the only way to import them is to re-run, which overwrites V2 history. The strangler window needs either a V1 write freeze or a delta importer of our own.
3. Never boot V2 under Node on this database.
4. The V1 engines were not tried against the migrated copy; whether they can still run on it is unknown and should be tested before any rollback plan relies on it.

**(iii) Which custom tables need our own migration path?** `session_lineage`, `session_lineage_origin`, `session_receipt`, `session_receipt_assessment`, `session_receipt_operation` (foreign keys to the legacy `session` table, and ids that must follow the sessions into `session_v2`), `runtime_busy`, `runtime_pending`, `runtime_session_owner` (live engine state keyed by session id and pid; should be drained, not migrated), and `provider_permission`. All were preserved row for row (identical row hashes), so "migration path" here means re-homing foreign keys and deciding retention, not recovery. Our `session.directories` column and `session.permission` have no V2 home (0 and 2,342 populated rows respectively). `data_migration`, `session_context_epoch` and `session_input` are dropped by upstream and need a decision (one `steer` input and one context epoch exist, for the same session).

**(iv) Estimated cutover duration on the real 9 GB database.** The measurement was on a 9.0 GB copy of that database, so there is little to scale: about 14 s to snapshot, about 12 s to archive the event table (plus about 47 s if the hash verification is run), and **about 60 to 90 s for the import** at 3,420 sessions and 640 MB of memory. Allow roughly **3 to 5 minutes** end to end including verification, with the engines quiesced. The import cost scales with sessions, messages and parts (about 26 ms per session here), not with the event table. These figures were taken on a busy machine (load 5 to 14) and a warm page cache; a cold read of a 9 GB file could add the I/O time of one sequential read.

## Acceptance criteria of #2047

| criterion | result |
|---|---|
| The note lists every table in the copy with source and imported row counts | yes, (a) and (b) |
| Every skipped or lossy item is listed, with the custom tables called out | yes, (c) and (d) |
| The note states whether the event table can be archived before import and compared afterwards | yes, Decision (i), tested |
| The live hub database and units are byte-for-byte unmodified afterwards | **Not provable by hash**, because three live engines keep writing the file (it grew by 11.6 MB during the spike). What is shown instead: the only operation on it was one `mode=ro` backup read of 14 s; no process of ours held it afterwards; the rest of its directory is unchanged; no unit was started, stopped or restarted; no signal was sent to a process we did not start. |

## Appendix: reproduction

1. Snapshot with `copy.py` (the backup API from a `mode=ro` handle). 2. `git clone $HOME/harmoniqs/opencode`, `git checkout 12f7e1b59a`, `bun install`. 3. Copy `spike-h0b.ts` into `packages/core/`. 4. `XDG_*` and `OPENCODE_TEST_HOME` into a temp directory, `OPENCODE_DB=<copy>`, `env -u BUN_INSPECT -u AMICODE_ENGINE_INSPECT bun spike-h0b.ts`. The driver refuses an `OPENCODE_DB` outside `/tmp/opencode/h0b/`. The Python helpers `counts.py`, `analyze.py`, `loss.py`, `parts.py`, `archive.py` produce the JSON files here.
