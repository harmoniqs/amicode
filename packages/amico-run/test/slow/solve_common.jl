# Single-qubit gate solve (gate chosen by the including script via GATES[GATE_TARGET_NAME]) exercising the run-dir contract end-to-end.
# Runs with cwd = run dir (amico-run sets that); writes result.toml + pulse.jld2 here.
# Follows the conventions the β.3 AGENTS.md template teaches the LLM:
#   - AMICODE_ITER key=value lines on stdout, flushed per iteration
#   - result.toml written atomically (temp + rename)
#   - final DONE line
# Written against Piccolo 0.11 (QuantumCollocation/DirectTrajOpt 0.8 stack).
using Piccolo
using JLD2
using TOML

# Per-iter callback machinery lives in DirectTrajOpt's internal IpoptSolverExt
# module (not re-exported by Piccolo); reach it through the solve! method table.
const IpoptSolverExt = first(filter(
    m -> string(m.module) == "DirectTrajOpt.IpoptSolverExt",
    collect(methods(solve!)))).module
const Callbacks = IpoptSolverExt.Callbacks

# Toy single-qubit system (matches the Piccolo docs intro + the frozen spike).
sys = QuantumSystem(0.5 * PAULIS[:Z], [PAULIS[:X], PAULIS[:Y]], [1.0, 1.0])

N = 51
T = 10.0
times = collect(range(0.0, T, length = N))
initial = 0.1 * randn(sys.n_drives, N)

pulse = ZeroOrderPulse(initial, times)
qtraj = UnitaryTrajectory(sys, pulse, GATES[GATE_TARGET_NAME])
qcp = SmoothPulseProblem(qtraj, N;
    piccolo_options = PiccoloOptions(timesteps_all_equal = true),
    ddu_bound = 1.0, Q = 100.0, R = 1e-2)

dto_prob = hasproperty(qcp, :prob) ? qcp.prob : qcp
iters = Ref(0)
cb_update = Callbacks.callback_update_trajectory_factory(dto_prob)
function cb_log(optimizer, optimizer_state; kwargs...)
    iters[] = Int(optimizer_state.iter_count)
    println("AMICODE_ITER iter=$(optimizer_state.iter_count) f=$(optimizer_state.obj_value) " *
            "inf_pr=$(optimizer_state.inf_pr) inf_du=$(optimizer_state.inf_du)")
    flush(stdout)
    return true
end

t0 = time()
solve!(qcp;
    max_iter = 150, print_level = 1,
    callback = Callbacks.callback_factory(cb_update, cb_log))
wall = time() - t0

fid = fidelity(qcp)

JLD2.save("pulse.jld2", "trajectory", dto_prob.trajectory)

open("result.toml.tmp", "w") do io
    TOML.print(io, Dict(
        "fidelity"     => fid,
        "iterations"   => iters[],
        "wall_seconds" => wall,
    ))
end
mv("result.toml.tmp", "result.toml"; force = true)

println("DONE fidelity=$(fid)")
flush(stdout)
