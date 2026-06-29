#!/usr/bin/env julia
# Minimal NON-Piccolo emitter for the producer round-trip lane (0.1d). amico-run
# runs this with cwd = the run dir and writes run.toml (first) + FINISHED (last);
# this writes a schema-conforming result.toml. The point is to exercise the real
# PRODUCER seam (amico-run + a Julia emitter → a live run-dir) in the fast tier,
# without a heavy Piccolo solve (the real solve is the slow/nightly extension).
# Uses only the TOML stdlib so it runs in any Julia env.
import TOML
println("AMICODE_ITER iter=1 f=1.000000e-03 inf_pr=1.0e-9 inf_du=1.0e-6"); flush(stdout)
open("result.toml.tmp", "w") do io
    TOML.print(io, Dict("schema_version" => "1", "fidelity" => 0.9999, "iterations" => 1))
end
mv("result.toml.tmp", "result.toml"; force = true)
println("DONE fidelity=0.9999"); flush(stdout)
