# ops/ — the fleet's production scripts

These scripts run ON THE MINI (the canonical server) under launchd. This repo is the
source of truth; `~/.amico/ops/` on the mini is a **deploy target** — deploy with
`ops/install.sh`, never edit the deployed copies by hand.

## What runs where

| script | cadence (launchd) | reads | writes / posts |
|---|---|---|---|
| `hub-restart.sh` | on demand (the `Amicode: Restart Hub Server` command drives it over SSH; agents may call it directly) | systemd --user unit state, `curl 127.0.0.1:4096` | atomic binary swap (stage → rename, no service stop), single-verb restart, verification line |

### The hub restart law (amicode#649, learned 2026-08-30 the hard way)

**Never inline `systemctl stop`/`restart` for the hub from an agent shell.** A
session hosted ON the hub kills its own runtime mid-command — an interruption
between a `stop` and the rest of the sequence overrides `Restart=always` and
leaves the hub down (14-minute incident, every client panel stuck at boot).
Always go through `hub-restart.sh` (trap-verified: the hub is never left down
by it) or, when inline is unavoidable, schedule it out-of-process:
`systemd-run --user --on-active=5s systemctl --user restart …`. The swap is
rename(2) over the running executable — atomic, no stop, ever.

| script | cadence (launchd) | reads | writes / posts |
|---|---|---|---|
| `fleet-status.sh` | every 5 min (`co.harmoniqs.fleet-status`) | ssh probes (mini/macbook/erlich), canonical chat DB, server lsof, `~/.amico/sync.log`, local repo scan | `~/.amico/ops/fleet-status.json` (the dashboard widget's input); macOS notification on server-guard state change |
| `fleet-alert.sh` | every 15 min (`co.harmoniqs.fleet-alert`) | `fleet-status.json`, state file | **Slack `#fleet`** — device transitions only (noise-gated; always-on hosts `mini erlich` notify, laptops never do); down->24h re-reminds once daily |
| `papers-digest/daily.sh` | daily ~09:00 (`co.harmoniqs.amicode-papers-digest`) | the frozen bundle | **Slack `#papers`** — top-5 quant-ph digest; appends to `papers-digest/log.txt` |
| `skill-freshness/run-skill-freshness.sh` | daily ~04:30 (`co.harmoniqs.skill-freshness`) | the three skill surfaces (repo public library, armonissima vault library, server staging tree), Julia package checkouts, the `#586` lint CLI | receipt line appended to `~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl`; on drift, the tracking issue "Skill freshness report (nightly)" in `harmoniqs/armonissima` (created once, then commented); reports under `skill-freshness/reports/` |
| `role-parity/run-role-parity-check.sh` | daily ~04:45 (**erlich** — the vault-visible machine; systemd pair `co.harmoniqs.role-parity.{service,timer}` under `ops/systemd/`. The launchd plist is the macOS-**secondary** declaration) | the role-card parity pin record (`packages/extension/test/fixtures/vault-agents/pin.json` — the engine-neutral role definitions at their pinned amicissimo revision, provenance without content per review B1) vs the amicissimo vault checkout, via the `#806` check CLI with `--fetch` (the drift compare never runs against stale remote-tracking refs; a fetch failure is the named unknown `vault-unfetchable`, never a green receipt) | receipt line (kind `role-parity`) appended to `~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl`; on drift (a pinned definition changed past the pin, a fixture mismatched its record, or the pin orphaned), the chore issue "Role-card parity pin behind the vault (nightly)" in `harmoniqs/amicode` (created once, then commented); a CLI pre-flight/runtime failure appends a named `check-failed` receipt, never an empty status |
| `session-archive/run-session-archive.sh` | daily ~04:00 (hub: launchd `co.harmoniqs.session-archive` with `--apply`; linux hosts: systemd pair `co.harmoniqs.session-archive.{service,timer}` under `ops/systemd/`) | the canonical chat DB (READ for features; writes go ONLY through the `sessions autoarchive` verb's archive primitive — never raw SQL), the #1303 junk classifier (in the CLI bundle), the `autoarchive_hours` retention preference (`~/.amico/amicode/session-retention.json`, default 48 h) | receipt line (kind `session-archive`: mode, scanned, archived count, ids) appended to `~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl` — one line per run, dry-run included (mode distinguishes); archives ONLY junk-bucket sessions (junk-greeting/dead-cast/probe) older than the age gate; sessions with pending todos and substantive sessions are never touched; fully reversible via `amico sessions restore <id>` |
| `shard-watch/run-shard-watch.sh` | daily ~04:15 (`co.harmoniqs.shard-watch`) | `amico fleet shard-watch` (amicode#1306): per configured client (`AMICO_SHARD_CLIENTS`, ssh aliases), a READ-ONLY session-id census of the client's chat DB over ssh, diffed against the canonical DB (the collision-check shape), plus an `lsof` check for a live local listener on the canonical port that is not the ssh forward | receipt line (kind `shard-watch`) appended to `~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl`; on divergence (missing ids ≥ `AMICO_SHARD_ALERT_MIN`, default 1, or a fork-signal listener) exit nonzero + the check posts the divergence summary to the fleet channel via amico-slack (the fleet-alert convention). DETECTION ONLY — every connection read-only, never a merge/kill/remediation (that is amicode#1302's human-coordinated flow); an unreachable client is a warning, never a divergence |

The launchd plists themselves are versioned alongside (`ops/launchd/`) — reference
copies; installing them is a one-time `launchctl load` on the mini (paths inside are
absolute to `/Users/aaron`). The linux-side cadence units are versioned at
`ops/systemd/` — one-time install on erlich: copy the `.service` + `.timer` into
`~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user
enable --now <unit>.timer`. Never edit the installed copies; this repo is the source.

## Runtime state (NOT in this repo, never overwritten by deploy)

`fleet-status.json`, `fleet-status.guard-state`, `fleet-alert.state`,
`fleet-alert.launchd.{out,err}`, `papers-digest/{log.txt,launchd.*}`,
`skill-freshness/{reports/,launchd.*}`, `role-parity/{launchd.*,systemd.*}`,
`session-archive/{launchd.*,systemd.*}`, `shard-watch/launchd.{out,err}` — all live under
`~/.amico/ops/` on the mini and belong to the running system. `install.sh` touches
none of them.

## The frozen-bundle pattern (papers-digest)

`papers-digest/daily.sh` runs a **frozen bundle**, never a repo checkout — branches
move; production must not. The bundle lives on the mini at
`~/.amico/ops/papers-digest/bin/`:

- `amico.js` — the compiled `amico` CLI dist (built from this repo)
- `amico.js.sha256` — its sidecar

**Upgrade procedure** (the server pattern):

```sh
# from a build of this repo (pnpm build in packages/cli or the dist pipeline):
cp <dist>/amico.js ~/.amico/ops/papers-digest/bin/amico.js
cd ~/.amico/ops/papers-digest/bin && shasum -a 256 amico.js > amico.js.sha256
```

The sha sidecar is what an operator compares against to know what's deployed; the
digest job never needs a restart (it execs the bundle each run).

## Hunts: `hunt.sh` (#426)

`hunt.sh` is the hardened hunt wrapper — it replaces the retired fire-and-forget
dispatch (`ssh <host> 'cd … && nohup … > /tmp/<hunt>.log 2>&1 &'`). It bounds the
command (`timeout -k`), ticks a heartbeat file, logs durably under
`~/.amico/ops/hunts/<id>/`, and creates a **fleet record** (`hunt-<id>`) at launch
so the hunt is tracked in the registry — status is `amico fleet list`, never
ps-grep, and `amico fleet sweep` on the host adopts the record if the wrapper dies
or the box reboots mid-hunt.

```sh
# retired:
ssh erlich 'cd ~/qldpc-challenge && nohup ~/.local/bin/uv run python -u research/candidates/<hunt>.py > /tmp/<hunt>.log 2>&1 &'
# now (bounded, heartbeated, durable, tracked — record hunt-<id>):
ssh erlich '~/.amico/ops/hunt.sh --id <hunt> --bg --timeout 12h -- \
  sh -c "cd ~/qldpc-challenge && ~/.local/bin/uv run python -u research/candidates/<hunt>.py"'
# status / post-mortem (reads records, not ps):
ssh erlich 'amico fleet list'          # or: amico fleet status --session hunt-<id>
ssh erlich 'amico fleet sweep'         # adopts records whose holder pid is gone
```

Re-running a taken `--id` uniquifies (`<id>-2`, …) — one record per run. The host
needs the `amico` CLI on PATH (or pass `--amico` / set `AMICO_BIN`). Deploy: on
the mini `ops/install.sh` covers it; on erlich copy it once:

```sh
ssh erlich 'mkdir -p ~/.amico/ops' && scp ops/hunt.sh erlich:.amico/ops/hunt.sh
```

Hunt artifacts (`~/.amico/ops/hunts/<id>/{hunt.log,heartbeat}`) are runtime
state — never overwritten by deploy, same as the state files below.

## Skill freshness: `skill-freshness/run-skill-freshness.sh` (#587)

Nightly cadence over the three skill surfaces, using the `#586` lint CLI from the
canonical repo checkout (`~/armonia/repos/amicode` — no frozen bundle needed; the
lint is TS run directly under node):

| surface | default dir | lint lane | min-skills floor |
|---|---|---|---|
| `public` | `packages/extension/skills` (repo checkout) | `--structural-only` | 20 |
| `internal` | `~/.amico/vaults/armonissima/skills` | full (package cross-check) | 50 |
| `staging` | `~/.amico/server/opencode-project-staging/opencode-project/skills` | full (package cross-check) | 45 |

Every real run appends ONE JSON line to the upgrade-receipts journal
(`~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl`,
`"kind":"skill-freshness"`); per-surface report JSONs land under
`skill-freshness/reports/`. Absent surface dirs are recorded as `"skipped"` —
the job degrades, never crashes. Exit code is driven by lint structural
failures only. On drift (structural>0 OR drifted>0 on any ran surface) it
opens (once) and subsequently comments the tracking issue **"Skill freshness
report (nightly)"** in `harmoniqs/armonissima` — searched by exact title
before creating, never duplicated; a `gh` failure marks
`issue_update_failed` on the receipt without changing the exit code.

`--dry-run` writes the reports and WOULD-DO lines but appends no receipt and
touches no issues — that is the tested seam
(`packages/extension/test/ops/skill_freshness_orchestrator.test.ts`).

Read-only with respect to skill content: the cadence reports drift, it never
edits skills, and there is no LLM judgment anywhere in the verdict path.

## Deploy

From a checkout of this repo on the mini:

```sh
ops/install.sh            # copies the three scripts to ~/.amico/ops/ (idempotent)
```

The install script copies scripts ONLY — no plists (one-time, by hand), no state
files, no bundle. After editing anything here: merge, then deploy, then
`launchctl kickstart` the affected agent if the change should take effect before its
next interval.
