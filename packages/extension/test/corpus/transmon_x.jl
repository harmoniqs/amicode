# Smoke-corpus fixture (1.4a, #61) — transmon single-qubit X gate, minimal.
#
# This file is a CI FIXTURE, not runnable physics: in the smoke suite it is
# "solved" by test/corpus/fake-julia, which reads the directive below and
# emits the same telemetry stream (AMICODE_PULSE_META / AMICODE_ITER /
# AMICODE_PULSE → run.log) + result.toml that an instrumented
# templates/solve_template.jl run produces. The parameter block mirrors the
# template's transmon-X defaults so the fixture stays recognizably that
# platform — if the telemetry contract changes, change the template, the
# emitter, and this directive together.
#
# AMICODE_SMOKE iters=4 drives=2 knots=8 fidelity=0.9993 dt=0.2 delay_ms=40

# -- template-shaped parameter block (documentation of the modeled solve) --
# levels    = 3        # computational + 1 leakage
# delta     = 0.2      # anharmonicity (GHz), positive convention
# drive_max = 0.2      # per-quadrature bound (GHz)
# T         = 10.0     # gate time (ns)
# N         = 8        # spline knots (smoke-scale; template default is 50)
# max_iter  = 4        # smoke-scale; template default is 60
# gate      = :X       # EmbeddedOperator(:X, sys) on the computational subspace
