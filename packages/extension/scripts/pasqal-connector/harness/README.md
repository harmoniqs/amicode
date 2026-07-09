# Pasqal chat harness

Stand up the Pasqal connector as a **chat session** and drive the whole
Piccolo → Pulser → Pasqal Cloud pipeline by **talking to Amico in plain
English**. The only thing you run by hand is this launcher; everything else
(solve, translate, simulate, submit, the demos) you ask Amico to do.

## Quick start

```bash
./pasqal-harness.sh
```

Then open the printed URL in your browser and start typing. Try:

- *"Run the connectivity test against EMU_FREE."* — Task A
- *"Solve an X gate, then translate and simulate it."* — Task B
- *"Do the atom-position sweep and show me the chart."* — Task E
- *"Submit the best Bell pulse to Pasqal Cloud."* — Task F (needs credentials)
- *"Show the W-state geometry demo — triangle vs chain."* — Task G
- *"Run the pair-packing demo."* — Task H
- *"Run the test harness."* — Task D

## What it does

1. **Seeds** a stable working dir (`~/.pasqal-harness/run` by default) from the
   committed connector scripts — the repo is the single source of truth. The
   scripts are flattened (they import each other as siblings), and the seed
   includes `AGENTS.md` (the protocol Amico follows) and the pre-solved pulses
   (`pulse_bell_d*.toml`, `pulse_w_*.toml`, `pulse_pairs_L*.toml`) so the demos
   run instantly with no ~1-minute solve.
2. **Health-checks** the environment, fail-fast: the vendored `opencode` binary,
   the Python deps (`pulser` + `pasqal-cloud`, tested via the real imports the
   scripts use), and the Julia project (a warning, not fatal — pre-solved
   demos work without it).
3. **Launches** the vendored amicode server (`opencode serve`) in the working
   dir and prints the chat URL (routed directly to the project session, which
   sidesteps the fork's broken home-page "Open chat" button).

Re-running **reuses** the working dir so any iteration you did there sticks.
`--fresh` wipes and reseeds from the repo.

## Flags & overrides

| | |
|---|---|
| `--fresh` | wipe the working dir and reseed from the repo |
| `--restart` | stop a running server, then relaunch |
| `--status` | print the chat URL if a server is running |
| `--stop` | stop a running server |
| `--port N` | bind a specific port (default 4270) |
| `PASQAL_HARNESS_DIR` | working dir (default `~/.pasqal-harness/run`) |
| `PASQAL_HARNESS_OPENCODE_BIN` | path to the `opencode` binary |
| `AMICO_JULIA_PROJECT` | Julia project for solves (default `~/.amico/julia`) |

## Credentials & safety

The harness **never touches secrets**. You type your Pasqal
username / password / project_id into the chat; Amico passes them as env vars
on a single bash invocation and never writes them to disk or repeats them back
(see `AGENTS.md`, "Credentials protocol").

`AGENTS.md` also enforces a **mandatory hardware gate**: local simulation and
EMU_FREE run freely, but real QPUs (FRESNEL/FRESNEL_CAN1) and paid emulators
are never submitted to without a digest and an explicit in-chat "yes".

## Layout

```
harness/
  pasqal-harness.sh   the launcher (this is the only thing you run)
  AGENTS.md           the protocol Amico follows (seeded into the working dir)
  pulses/             pre-solved Bell / W / pair-packing pulses
  opencode/           .opencode config template (opencode.json)
  README.md
```

The scripts themselves live one level up in `../` and `../spike/` — the
launcher copies them into the working dir at seed time.
