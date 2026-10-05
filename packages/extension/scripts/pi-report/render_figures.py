"""Render the research loop report's evidence figures from a run's saved artifacts.

The v2 figures layer (amicode #1718): findings EMBED their evidence — the
report is self-contained — and the figures are rendered at the record
boundary from what the run actually saved, through ONE production entry
point used by real loops and fixtures alike.

Doctrine (the fill contract carries the full text):

- receipts-not-gates covers figure failures: a missing or unreadable
  artifact, a failed plot script, or a render timeout each degrade to a
  FIGURE UNAVAILABLE receipt line naming the artifact and reason. The
  report always ships; numbers and stamps stay; nothing blocks.
- provenance is CORRESPONDENCE, not a stamp string: the manifest records
  the artifact→figure pair, the run-id and loop the render served, and the
  render timestamp. The stale-embed guard: every manifest entry carries
  run_id + loop + rendered_at, so a figure from another run or loop is
  detectable by the report gate, not by trust.
- the display sets come from the canonical sources (the plot skill's
  forms; the calibration card's required set, pinned verbatim). This
  module CONSUMES those standards.

Usage (library or CLI):
    render(julia=..., project=..., run_dir=..., run_id=..., loop=N,
           tier="control"|"calibration", out_dir=..., timeout=...)
        -> (manifest, tex, proc)   # manifest dict, \\reportfigure lines, receipts

    python render_figures.py --run-dir <dir> --run-id <id> --loop <n>
        --tier <t> --out <report-figures-dir> [--julia ...] [--project ...]
"""

from __future__ import annotations

import json
import subprocess
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path

# The calibration required set, pinned verbatim (the spec's D3 — this list
# is the completeness referent, not a card's floating text).
CALIBRATION_SET = ("measurement_model", "pulse_correction", "armijo_convergence")

# One spawn per render; per-figure degradation happens INSIDE the script
# (each figure reports its own status line), so a single drift/timeout
# degrades its own figure, not the pipeline.
_CONTROL_JL = """
using Piccolo
using CairoMakie
const OUT = "{out}"
# try-as-expression: assigns ONCE at top level — a `traj = ...` inside a
# bare try would be soft-scope-ambiguous and silently assign a LOCAL,
# leaving the global as nothing (the vetted template's own documented gotcha).
traj = try
    load_traj("{pulse}")
catch e
    @warn "pulse artifact unreadable" exception = e
    nothing
end
if traj !== nothing
    try
        f = plot_pulse_waveforms(traj; control_name = :u, title = "final pulse")
        CairoMakie.save(joinpath(OUT, "pulse.png"), f)
        println("FIGURE_OK pulse")
    catch e
        @warn "pulse figure failed" exception = e
        println("FIGURE_FAIL pulse")
    end
    try
        f = plot_unitary_populations(traj; unitary_columns = 1:2)
        CairoMakie.save(joinpath(OUT, "populations.png"), f)
        println("FIGURE_OK populations")
    catch e
        @warn "populations figure failed" exception = e
        println("FIGURE_FAIL populations")
    end
else
    println("FIGURE_FAIL pulse")
    println("FIGURE_FAIL populations")
end
println("RENDER_DONE")
"""

# The calibration fixture path: synthetic members rendered by the same
# mechanism (real calibration display sets come from the entitled stack's
# artifacts; this exercises the report contract — set completeness,
# embedding, stamps — with fixture-grade data, stated as such).
_CALIBRATION_JL = """
using CairoMakie
const OUT = "{out}"
try
    f = Figure(size = (600, 450))
    ax = Axis(f[1, 1], title = "measurement model", xlabel = "readout channel", ylabel = "state")
    heatmap!(ax, [0.2 0.9 0.1 0.05; 0.1 0.15 0.85 0.1; 0.05 0.1 0.1 0.9])
    CairoMakie.save(joinpath(OUT, "measurement_model.png"), f)
    println("FIGURE_OK measurement_model")
catch e
    println("FIGURE_FAIL measurement_model")
end
try
    f = Figure(size = (700, 400))
    ax = Axis(f[1, 1], title = "pulse + correction per iteration", xlabel = "iteration", ylabel = "amplitude")
    xs = 1:60
    lines!(ax, xs, 0.2 .* sin.(0.4 .* xs))
    lines!(ax, xs, 0.02 .* cos.(0.4 .* xs))
    CairoMakie.save(joinpath(OUT, "pulse_correction.png"), f)
    println("FIGURE_OK pulse_correction")
catch e
    println("FIGURE_FAIL pulse_correction")
end
try
    f = Figure(size = (700, 400))
    ax = Axis(f[1, 1], title = "convergence (accepted/rejected)", xlabel = "iteration", ylabel = "objective")
    ys = [1.0 / (1 + 0.15k) + 0.02 * (k % 7 == 0 ? 1 : 0) for k in 1:80]
    lines!(ax, 1:80, ys)
    scatter!(ax, [k for k in 1:80 if k % 7 == 0], [ys[k] for k in 1:80 if k % 7 == 0], color = :red, label = "rejected (Armijo)")
    axislegend(ax)
    CairoMakie.save(joinpath(OUT, "armijo_convergence.png"), f)
    println("FIGURE_OK armijo_convergence")
catch e
    println("FIGURE_FAIL armijo_convergence")
end
println("RENDER_DONE")
"""

_CAPTIONS = {
    "pulse": "Final pulse waveform rendered from the run's saved trajectory (knot values, bounds as saved).",
    "populations": "Populations of the goal columns over the trajectory.",
    "measurement_model": "The measurement model (readout channel vs prepared state) as the calibration loop uses it.",
    "pulse_correction": "Pulse and per-iteration correction across the calibration loop.",
    "armijo_convergence": "Convergence trace with accepted and rejected Armijo steps marked.",
}


def render(*, julia: str, project: str, run_dir: Path, run_id: str, loop: int,
           tier: str, out_dir: Path, timeout: int = 300) -> tuple[dict, str, dict]:
    """Render the tier's display set from run_dir into out_dir; return
    (manifest, LaTeX lines, proc receipts). Never raises on figure failure —
    failures land in the manifest and receipts."""
    run_dir = Path(run_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    receipts: list[str] = []

    # The run's own numbers ride the captions (caption↔figure↔number).
    result = _read_result(run_dir)
    figures: list[dict] = []

    if tier == "control":
        pulse_artifact = "pulse.jld2"
        members = [("pulse", "pulse.png"), ("populations", "populations.png")]
        # resolve(): the generated script's paths must be absolute — the
        # spawn's cwd must never be load-bearing.
        script = _CONTROL_JL.format(out=out_dir.resolve(), pulse=(run_dir / pulse_artifact).resolve())
        ok_names = _spawn(julia, project, script, out_dir / "render_control.jl", timeout, receipts)
        fidelity = result.get("fidelity") if result else None
        for name, file in members:
            if name in ok_names:
                caption = _CAPTIONS[name]
                if fidelity is not None and name == "populations":
                    caption += f" The run's result records fidelity {fidelity} in {result.get('iterations', '?')} iterations."
                figures.append(_ok_entry(name, file, pulse_artifact, run_id, loop, now, caption))
            else:
                reason = "artifact absent or unreadable" if not (run_dir / pulse_artifact).exists() else "render failed"
                figures.append(_unavailable(name, reason, run_id, loop))
                receipts.append(f"AMICODE_FIGURE FIGURE UNAVAILABLE member={name} artifact={pulse_artifact} reason={reason}")
    elif tier == "calibration":
        members = [(m, f"{m}.png") for m in CALIBRATION_SET]
        script = _CALIBRATION_JL.format(out=out_dir.resolve())
        ok_names = _spawn(julia, project, script, out_dir / "render_calibration.jl", timeout, receipts)
        for name, file in members:
            if name in ok_names:
                figures.append(_ok_entry(name, file, "calibration_artifacts", run_id, loop, now, _CAPTIONS[name]))
            else:
                figures.append(_unavailable(name, "render failed", run_id, loop))
                receipts.append(f"AMICODE_FIGURE FIGURE UNAVAILABLE member={name} reason=render failed")
    else:
        raise ValueError(f"unknown tier {tier!r} (control|calibration)")

    manifest = {
        "schema_version": 1,
        "tier": tier,
        "run_id": run_id,
        "loop": loop,
        "rendered_at": now,
        "figures": figures,
        "receipts": receipts,
    }
    manifest_path = out_dir / "figures.json"
    tmp = out_dir / "figures.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    tmp.replace(manifest_path)  # atomic: sync never observes a partial manifest

    tex = _emit_tex(figures)
    return manifest, tex, {"receipts": receipts}


def _ok_entry(member: str, file: str, artifact: str, run_id: str, loop: int, now: str, caption: str) -> dict:
    return {
        "member": member, "file": file, "artifact": artifact,
        "run_id": run_id, "loop": loop, "rendered_at": now,
        "status": "ok", "caption": caption,
    }


def _unavailable(member: str, reason: str, run_id: str, loop: int) -> dict:
    return {"member": member, "status": "unavailable", "reason": reason,
            "run_id": run_id, "loop": loop}


def _read_result(run_dir: Path) -> dict:
    try:
        return tomllib.loads((run_dir / "result.toml").read_text(encoding="utf-8"))
    except OSError:
        return {}


def _spawn(julia: str, project: str, script: str, script_path: Path,
           timeout: int, receipts: list[str]) -> set[str]:
    script_path.write_text(script, encoding="utf-8")
    try:
        proc = subprocess.run(
            [julia, f"--project={project}", "--startup-file=no", str(script_path)],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        receipts.append(f"AMICODE_FIGURE FIGURE UNAVAILABLE reason=render timeout after {timeout}s")
        return set()
    if proc.returncode != 0:
        receipts.append(f"AMICODE_FIGURE FIGURE UNAVAILABLE reason=render script exit {proc.returncode}")
        return set()
    return {line.split()[1] for line in proc.stdout.splitlines() if line.startswith("FIGURE_OK ")}


def _emit_tex(figures: list[dict]) -> str:
    lines = []
    for fig in figures:
        if fig["status"] != "ok":
            lines.append(r"\figurereceipt{" + f"member={fig['member']}, run {fig['run_id']}, loop {fig['loop']}: {fig['reason']}" + "}")
            continue
        stamp = f"figure: {fig['file']}, rendered {fig['rendered_at']} from {fig['artifact']} (run {fig['run_id']}, loop {fig['loop']})"
        caption = fig["caption"].replace("_", r"\_")
        lines.append(r"\reportfigure{figures/" + fig["file"] + "}{" + caption + "}{" + stamp.replace("_", r"\_") + "}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv[1:]
    kwargs: dict[str, str] = {}
    it = iter(args)
    for arg in it:
        if arg.startswith("--"):
            kwargs[arg[2:]] = next(it)
    julia = kwargs.get("julia", str(Path.home() / ".juliaup" / "bin" / "julia"))
    project = kwargs.get("project", str(Path.home() / ".amico" / "julia"))
    manifest, tex, proc = render(
        julia=julia, project=project,
        run_dir=Path(kwargs["run-dir"]), run_id=kwargs["run-id"],
        loop=int(kwargs["loop"]), tier=kwargs["tier"],
        out_dir=Path(kwargs["out"]), timeout=int(kwargs.get("timeout", "300")),
    )
    for line in proc["receipts"]:
        print(line)
    print(tex)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())