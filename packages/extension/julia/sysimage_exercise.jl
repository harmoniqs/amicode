# Precompile-execution workload for the amico sysimage build. Exercises exactly
# the code paths a real solve hits — TransmonSystem / EmbeddedOperator /
# SmoothPulseProblem / solve! (Ipopt) / plot_pulse (Makie render+save) / rollout
# / unitary_fidelity — so PackageCompiler bakes their compiled methods into the
# sysimage. That removes the ~80s first-iter JIT and the ~35s first-plot compile.
# Kept tiny (few iters) — we want coverage, not convergence.
using Piccolo
using CairoMakie
using JLD2
using TOML
using Printf

try
    sys = TransmonSystem(; δ = 0.2, levels = 3, drive_bounds = fill(0.2, 2))
    op  = EmbeddedOperator(GATES[:X], sys)
    times = collect(range(0.0, 10.0, length = 20))
    qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(0.1 * randn(sys.n_drives, 20), times), op)
    qcp = SmoothPulseProblem(qtraj, 20;
        piccolo_options = PiccoloOptions(timesteps_all_equal = true), Q = 100.0, R = 1e-2)
    solve!(qcp; max_iter = 3, print_level = 0)

    # plot path (the expensive first-render compile we most want baked)
    fig = plot_pulse(qcp; bounds = true)
    CairoMakie.save(tempname() * ".png", fig)

    # rollout + subspace fidelity (the result metric) + JLD2/TOML serialization
    Uroll = iso_vec_to_operator(unitary_rollout(get_trajectory(qcp), sys)[:, end])
    unitary_fidelity(Uroll, op.operator; subspace = op.subspace)
    mktempdir() do d
        JLD2.save(joinpath(d, "p.jld2"), "traj", qcp isa Any ? get_trajectory(qcp) : nothing)
        open(joinpath(d, "r.toml"), "w") do io; TOML.print(io, Dict("fidelity" => 0.99)); end
    end
    @info "sysimage exercise complete"
catch e
    @warn "sysimage exercise hit an error (sysimage still builds; coverage may be partial)" exception = e
end
