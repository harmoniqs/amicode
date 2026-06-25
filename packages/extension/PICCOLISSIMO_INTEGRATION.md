# Amicode → Piccolissimo (beta target)

Amicode's beta will run solves through **Piccolissimo** (the Harmoniqs commercial
stack: Piccolissimo + Altissimo), not raw Piccolo. Piccolissimo bundles Piccolo
and adds exact integrators, so "everything Piccolo can do, and more." This doc is
the running record of what's verified and what the binary integration still needs.

## Status

- ✅ **Solve template verified** — `templates/solve_template_piccolissimo.jl` runs
  end-to-end through `amico-run` and converges: single-qubit transmon **X gate**,
  3-level, **F = 0.99995** in 60 iters (~88 s cold), full run-dir contract +
  `plot_pulse` frames.
- ⏳ **Not yet the live default.** `AGENTS.md` + the bundled julia project still
  point at raw Piccolo (`solve_template.jl`), because a *source* install of
  Piccolissimo is not distributable (see Altissimo below). The swap happens once
  the Piccolissimo binary is consumable.
- 🔭 **Binary distribution is Jack's in-flight work** (Piccolissimo
  `Build.yml` → tarball → Cloudflare R2 / GitHub release).

## What the template needed (lessons from verification)

1. **Piccolissimo does not reexport Piccolo.** Load **both** (`using Piccolo;
   using Piccolissimo`). `using Piccolissimo` alone is missing `GATES`,
   `TransmonSystem`, `SmoothPulseProblem`, `plot_pulse`, …
2. **Pin the timesteps.** `PiccoloOptions(timesteps_all_equal = true)` is required
   — with a free Δt the dual infeasibility oscillates and the solve stalls at
   F≈0.976; pinned, it reaches F≈0.99995. Same lesson as the raw-Piccolo template.
3. **Piccolo version differs.** Piccolissimo pins **Piccolo 1.10**; the raw
   template was vetted on **Piccolo 1.19**. The symbols the template uses all
   exist in 1.10 (`GATES`, `TransmonSystem`, `EmbeddedOperator`,
   `UnitaryTrajectory`, `ZeroOrderPulse`, `SmoothPulseProblem`, `solve!`,
   `plot_pulse`, `unitary_rollout`, `unitary_fidelity`, `iso_vec_to_operator`,
   `get_trajectory`, `Piccolo.Callbacks`).

## Why source isn't distributable (→ binary is the only path)

Piccolissimo's Manifest pins **Altissimo** (the solver) to a local, unregistered
path dep: `path = "/Users/raghavchari/Altissimo.jl"`, `version 1.0.0-DEV`. An end
user can't `Pkg.add` Piccolissimo and resolve Altissimo. The prebuilt image,
which bakes Altissimo in, is the only delivery vehicle.

## Integration contract for the binary (what amicode needs from the build)

The current published artifact (`rel-0.3.0-test1`) is:
`piccolissimo-pkgimage-0.3.0-x86_64-linux-gnu-julia1.12.6.tar.zst`. For amicode to
consume it:

1. **It's a `pkgimage`, not a `sysimage`.** It loads by extracting into the Julia
   depot's compiled cache (`JULIA_DEPOT_PATH`), **not** via `julia --sysimage`.
   amico-run's existing `--sysimage <path>` flag does **not** apply as-is — wiring
   a pkgimage means an extract step + depot env, *or* the build also emits a true
   sysimage we can point `--sysimage` at. (Decide which with Jack.)
2. **Per-platform builds.** Only `x86_64-linux-gnu` is published today. macOS lab
   machines need `aarch64-apple-darwin` (the workflow has the matrix entry; the
   asset just isn't published yet).
3. **Julia version must match.** The pkgimage is tied to **julia 1.12.6**; amicode
   must ship/require exactly that Julia. (Dev machine here is 1.12.3 — mismatch.)
4. **CairoMakie is not in Piccolissimo's deps.** The pkgimage won't accelerate
   `plot_pulse` — the ~35 s Makie first-plot JIT remains. If amicode wants fast
   plotting too, **CairoMakie must be baked into the amicode image** (or we accept
   the one-time plot warm-up).
5. **License gate.** `Piccolissimo.validate_license()` (checks
   `PICCOLISSIMO_LICENSE` / `~/.config|Library/.../license.key` against a Harmoniqs
   server) is currently **commented out** in `__init__`, with the note
   *"re-enable once binaries are deployed."* When it turns on, amicode provisioning
   (β.4 install.sh / healthcheck) must supply `PICCOLISSIMO_LICENSE` the same way
   it handles Bedrock creds.

## When the binary lands — the amicode swap

1. Point `AGENTS.md` (template ref) at `solve_template_piccolissimo.jl`.
2. Bundle/provision a Piccolissimo julia project (or rely on the pkgimage depot).
3. Wire the pkgimage load path in amico-run / install.sh (per contract #1).
4. Add `PICCOLISSIMO_LICENSE` to provisioning + healthcheck (per contract #5).

## Local verification recipe (reproduces F=0.99995)

Requires the local commercial stack checked out (`~/Piccolissimo.jl`,
`~/Altissimo.jl`) with the license gate disabled (current state).

```julia
using Pkg
Pkg.activate("/tmp/amicode-pcl-env")
Pkg.develop(path="/Users/raghavchari/Altissimo.jl")      # unregistered path dep
Pkg.develop(path="/Users/raghavchari/Piccolissimo.jl")
Pkg.add("Piccolo"); Pkg.add("CairoMakie"); Pkg.add("JLD2")
Pkg.instantiate()
```

```sh
node packages/amico-run/dist/amico-run.js \
  packages/extension/templates/solve_template_piccolissimo.jl \
  --project /tmp/amicode-pcl-env --runs-root /tmp/pcl-runs
# → AMICODE_FINISHED status=completed exitCode=0, result.toml fidelity = 0.99995
```
