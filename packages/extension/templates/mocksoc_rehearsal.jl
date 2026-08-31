#!/usr/bin/env julia
# ============================================================================
# MockSoc rehearsal (SEAM 1, amicode #680) — the solved pulse runs a full sim
# rehearsal through the ACTUAL Strumento.jl transport seam, in pure Julia:
#
#   translate (pulse → QICK envelopes) → load → execute! (board-free rollout,
#   synthetic IQ) → iq_to_measurements (Measurement) → one strategy step
#   (IdentityStrategy — the rehearsal proves the TRANSPORT seam, not a strategy).
#
# NO bespoke simulation: every physics step runs through Strumento/Intonato/
# Piccolo code (MockSoc is Strumento's Piccolo extension; StrumentoBackend /
# StrumentoExperiment / PulseTuningProblem are Intonato ≥ 0.4's absorbed
# hardware seam). This file only wires them together and records the result.
#
# The artifact it writes (rehearsal.toml, ATOMIC — .tmp then rename) is the
# device-session rehearsal record: honestly labeled `sim = true`, carrying the
# pulse content-hash, the mock system's mismatch declaration, and the
# strategy-step outcome. Outcome-gated on the CONSUMER side (amicode_to_hardware):
# `outcome = "success"` satisfies the hardware stage; `"failed"` does NOT — the
# stage stays an honest stub until a rehearsal passes.
#
# Env (committed alongside this script in templates/mocksoc-rehearsal/):
#   Strumento 0.3 (registered) + Intonato ≥ 0.4 (the absorbed hardware seam,
#   depends on Strumento) + Piccolo 2.x. Resolve + instantiate from the General
# registry once, then always run with --startup-file=no:
#
#   julia --startup-file=no --project=<this dir's parent>/mocksoc-rehearsal \
#         mocksoc_rehearsal.jl <pulse.jld2> <result.toml> [out_dir]
#
#   pulse.jld2  — the solved pulse artifact (key "traj", a NamedTrajectory;
#                 what every amico-run solve writes)
#   result.toml — the run's self-describing record ([params]: delta/levels/
#                 T/N/drive_max — the regime the run actually solved)
#   out_dir     — where rehearsal.toml lands (default: the pulse's directory)
#
# Exit codes: 0 = success, 1 = rehearsal FAILED (artifact still written),
#            2 = contract error (bad args / unreadable inputs — no artifact).
# Stdout ends with one `REHEARSAL outcome=… pulse_hash=…` line for callers.
# ============================================================================

using Intonato         # the QILC chassis; reexports Piccolo + Strumento's soc surface + MockSoc
using JLD2
using TOML
using SHA
using Dates
using LinearAlgebra

# ── the rehearsal's declared mock truth (edit before a run if you like) ──────
const MISMATCH_PARAM  = "delta"   # which nominal param the mock system perturbs
const MISMATCH_FACTOR = 1.05      # ×1.05: the mock "hardware" runs δ 5% off-model
const DAC_RATE        = 20.0      # samples per ns on the mock DAC grid
const CARRIER_FREQ    = 5e9       # Hz, channel-map metadata (MockSoc is baseband)

# ── tiny atomic-TOML writer (the run-dir contract's discipline, self-contained)
function write_atomic_toml(path::String, tables::String)
    tmp = path * ".tmp"
    open(tmp, "w") do io
        print(io, tables)
    end
    mv(tmp, path; force = true)
    return nothing
end

function toml_str(s::AbstractString)
    escaped = replace(replace(replace(replace(replace(String(s),
        "\\" => "\\\\"),
        "\"" => "\\\""),
        "\n" => "\\n"),
        "\r" => "\\r"),
        "\t" => "\\t")
    return "\"$escaped\""
end

function rehearsal_toml(; outcome::String, pulse_hash::String, mismatch::String,
                        step_outcome::Union{String,Nothing}, error_msg::Union{String,Nothing},
                        recorded::String)
    io = IOBuffer()
    println(io, "schema_version = \"1\"")
    println(io, "")
    println(io, "[rehearsal]")
    println(io, "kind = \"mocksoc\"")
    println(io, "sim = true")                       # PINNED: a rehearsal is sim, never hardware
    println(io, "outcome = ", toml_str(outcome))
    println(io, "pulse_hash = ", toml_str("sha256:" * pulse_hash))
    println(io, "mismatch = ", toml_str(mismatch))
    if step_outcome !== nothing
        println(io, "step_outcome = ", toml_str(step_outcome))
    end
    if error_msg !== nothing
        println(io, "error = ", toml_str(error_msg))
    end
    println(io, "recorded = ", toml_str(recorded))
    return String(take!(io))
end

# ── contract: two or three argv ──────────────────────────────────────────────
if length(ARGS) < 2 || length(ARGS) > 3
    println(stderr, "usage: julia mocksoc_rehearsal.jl <pulse.jld2> <result.toml> [out_dir]")
    exit(2)
end
const PULSE_PATH  = abspath(ARGS[1])
const RESULT_PATH = abspath(ARGS[2])
const OUT_DIR     = length(ARGS) == 3 ? abspath(ARGS[3]) : dirname(PULSE_PATH)
const OUT_PATH    = joinpath(OUT_DIR, "rehearsal.toml")

isfile(PULSE_PATH)  || (println(stderr, "rehearsal: pulse not found: $PULSE_PATH");  exit(2))
isfile(RESULT_PATH) || (println(stderr, "rehearsal: result.toml not found: $RESULT_PATH"); exit(2))
mkpath(OUT_DIR)

const RECORDED = Dates.format(now(UTC), dateformat"yyyy-mm-dd\THH:MM:SS\Z")

# The pulse content-hash: what the artifact binds the rehearsal to. The hash is
# over the pulse.jld2 BYTES, so the record names exactly the artifact rehearsed.
const PULSE_HASH = bytes2hex(SHA.sha256(read(PULSE_PATH)))

function fail!(err_msg::AbstractString)
    toml = rehearsal_toml(
        outcome = "failed",
        pulse_hash = PULSE_HASH,
        mismatch = "$MISMATCH_PARAM × $MISMATCH_FACTOR (mock truth vs nominal model)",
        step_outcome = nothing,
        error_msg = String(err_msg),
        recorded = RECORDED,
    )
    write_atomic_toml(OUT_PATH, toml)
    println("REHEARSAL outcome=failed pulse_hash=sha256:$PULSE_HASH")
    flush(stdout)
    exit(1)
end

# ── the rehearsal itself — every step through the real transport seam ───────
try
    params = TOML.parsefile(RESULT_PATH)
    haskey(params, "params") ||
        error("result.toml carries no [params] table — not an amico-run result record")
    rp = params["params"]
    δ        = Float64(rp["delta"])
    levels   = Int(rp["levels"])
    N        = Int(rp["N"])
    drive_max = Float64(rp["drive_max"])
    T        = Float64(get(rp, "T", 0.0))

    # 1. Load the SOLVED pulse (key "traj" — the warm-start contract every
    #    solve writes) and extract its drive knots. The drive component is
    #    :u on current Piccolo problems, :a on legacy ones; knot times come
    #    from the trajectory (a TimeWarp solve's times are the solved ones).
    traj = load_traj(PULSE_PATH)
    names = traj.names
    drive_name = :u in names ? :u : (:a in names ? :a : error(
        "no drive component (:u/:a) on the saved trajectory"))

    # Cross-version honesty: a pulse.jld2 written by an older NamedTrajectories
    # (the provisioned solve env) reconstructs as a raw JLD2 object when this
    # env's NamedTrajectory grew a field — component getindex is unavailable
    # there, but the SAVED FIELDS (datavec/dim/N/components) always are, and
    # the (dim × N) per-knot column layout is the format's contract. Try the
    # native path first; fall back to the raw fields only when reconstruction
    # left the object untyped. Either way the values are the solved knots —
    # no re-simulation, no interpolation.
    function knot_matrix(name::Symbol)
        rows = traj.components[name]
        if applicable(getindex, traj, name)
            return Matrix{Float64}(traj[name])
        end
        d = length(rows)
        M = Matrix{Float64}(undef, d, traj.N)
        for k in 1:traj.N
            base = (k - 1) * traj.dim
            for (i, r) in enumerate(rows)
                M[i, k] = Float64(traj.datavec[base + r])
            end
        end
        return M
    end

    u = knot_matrix(drive_name)
    times = if :t in names
        vec(knot_matrix(:t))
    elseif :Δt in names
        cumsum(vec(knot_matrix(:Δt)))
    else
        T > 0 ? collect(range(0.0, T, length = traj.N)) :
            error("no knot times (:t/:Δt) on the saved trajectory and no T in [params]")
    end
    n_drives = size(u, 1)
    size(u, 2) == length(times) ||
        error("drive knots ($(size(u, 2))) and knot times ($(length(times))) disagree")

    # Linear-spline pulse over the solved knots — the object the QICK seam
    # samples onto the DAC grid. Declared in the artifact so the record says
    # exactly what shape rode the transport.
    pulse = LinearSplinePulse(u, times)

    # 2. The systems. Nominal: the model the solve used (from result.toml's
    #    self-describing params). Mock truth: the SAME system with the DECLARED
    #    mismatch — that mismatch is what makes the strategy step's J_exp
    #    nonzero, i.e. what the rehearsal observes honestly.
    sys_nom  = TransmonSystem(; δ = δ, levels = levels, drive_bounds = fill(drive_max, 2))
    sys_mock = TransmonSystem(; δ = δ * MISMATCH_FACTOR, levels = levels,
                              drive_bounds = fill(drive_max, 2))

    # The rehearsal's probe pair: |0⟩ → |1⟩ on the computational subspace.
    # A GATE pulse acts on many states; the transport seam needs one probe
    # pair to roll out, and this is the declared one (recorded below).
    ψ0 = ComplexF64[1.0, zeros(levels - 1)...]
    ψg = ComplexF64[0.0, 1.0, zeros(levels - 2)...]

    # 3. The board-free QICK stack — verbatim the hardware-loop idiom:
    #    MockSoc (Strumento's Piccolo extension) → StrumentoBackend →
    #    StrumentoExperiment (translate → envelopes → execute! → synthetic
    #    IQ → Measurement). Two drive quadratures ride one complex channel.
    soc = MockSoc(sys_mock, ψ0, ψg; dac_rate = DAC_RATE)
    channel_map = QickChannelMap([QickGenChannel(0, CARRIER_FREQ;
                                                i_drive = 1,
                                                q_drive = n_drives ≥ 2 ? 2 : nothing)];
                                 n_drives = n_drives)
    backend = StrumentoBackend(soc, channel_map, [N])
    model = MeasurementModel(:ψ̃, [populations], [N])
    qexp = StrumentoExperiment(backend; measurement_model = model)

    # 4. The nominal QCP around the SOLVED pulse (warm-started at the solved
    #    knots — no re-solve), so the strategy step runs on the real artifact.
    #    min_nominal_fidelity = 0: the probe pair is a declared transport
    #    probe, not a physics claim — fidelity quality is the SOLVE's
    #    contract (result.toml + the verification gate), not the rehearsal's.
    qtraj = KetTrajectory(sys_nom, pulse, ψ0, ψg)
    # Construction chatter (variable/equality counts) is suppressed: the
    # rehearsal's stdout contract is the REHEARSAL line + errors, nothing else.
    qcp = redirect_stdout(devnull) do
        SplinePulseProblem(qtraj, N; Q = 100.0, R = 1e-2)
    end
    ptp = PulseTuningProblem(qcp, qexp, model)   # IdentityStrategy (the default)

    # 5. ONE strategy step: solve! runs the outer loop once — the experiment
    #    rides the whole transport seam and the record carries its outcome.
    solve!(ptp; max_iter = 1, line_search = false, min_nominal_fidelity = 0.0,
           verbose = false, ipopt_options = (max_iter = 200, verbose = false, print_level = 0))
    isempty(ptp.result.history) && error("the strategy step produced no iteration record")

    rec = ptp.result.history[end]
    n_meas = length(rec.y_exp)
    step_outcome = "IdentityStrategy step: $(n_meas) measurement(s), J_exp=$(round(rec.J_exp, sigdigits = 4)), accepted=$(rec.accepted)"

    mismatch = "$MISMATCH_PARAM × $MISMATCH_FACTOR (mock truth vs nominal model)"
    toml = rehearsal_toml(
        outcome = "success",
        pulse_hash = PULSE_HASH,
        mismatch = mismatch,
        step_outcome = step_outcome,
        error_msg = nothing,
        recorded = RECORDED,
    )
    write_atomic_toml(OUT_PATH, toml)
    println("REHEARSAL outcome=success pulse_hash=sha256:$PULSE_HASH")
    flush(stdout)
catch err
    # The message, not the whole stacktrace — the artifact carries what failed;
    # the full traceback stays in this run's stderr (Julia prints it).
    msg = sprint(showerror, err)
    fail!(first(split(msg, "\nStacktrace:")))
end
