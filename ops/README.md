# ops/ — the fleet's production scripts

These scripts run ON THE MINI (the canonical server) under launchd. This repo is the
source of truth; `~/.amico/ops/` on the mini is a **deploy target** — deploy with
`ops/install.sh`, never edit the deployed copies by hand.

## What runs where

| script | cadence (launchd) | reads | writes / posts |
|---|---|---|---|
| `fleet-status.sh` | every 5 min (`co.harmoniqs.fleet-status`) | ssh probes (mini/macbook/erlich), canonical chat DB, server lsof, `~/.amico/sync.log`, local repo scan | `~/.amico/ops/fleet-status.json` (the dashboard widget's input); macOS notification on server-guard state change |
| `fleet-alert.sh` | every 15 min (`co.harmoniqs.fleet-alert`) | `fleet-status.json`, state file | **Slack `#fleet`** — device transitions only (noise-gated; always-on hosts `mini erlich` notify, laptops never do); down->24h re-reminds once daily |
| `papers-digest/daily.sh` | daily ~09:00 (`co.harmoniqs.amicode-papers-digest`) | the frozen bundle | **Slack `#papers`** — top-5 quant-ph digest; appends to `papers-digest/log.txt` |

The launchd plists themselves are versioned alongside (`ops/launchd/`) — reference
copies; installing them is a one-time `launchctl load` on the mini (paths inside are
absolute to `/Users/aaron`).

## Runtime state (NOT in this repo, never overwritten by deploy)

`fleet-status.json`, `fleet-status.guard-state`, `fleet-alert.state`,
`fleet-alert.launchd.{out,err}`, `papers-digest/{log.txt,launchd.*}` — all live under
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

## Deploy

From a checkout of this repo on the mini:

```sh
ops/install.sh            # copies the three scripts to ~/.amico/ops/ (idempotent)
```

The install script copies scripts ONLY — no plists (one-time, by hand), no state
files, no bundle. After editing anything here: merge, then deploy, then
`launchctl kickstart` the affected agent if the change should take effect before its
next interval.
