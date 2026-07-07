# Smoke-corpus fixture (1.4a, #61) — bosonic cavity displacement, minimal.
# Second platform so the corpus isn't shaped by one telemetry profile: a
# single-drive, shorter solve (different drives/knots/iters than transmon_x).
#
# CI FIXTURE, not runnable physics — see transmon_x.jl for the mechanism
# (test/corpus/fake-julia interprets the directive below).
#
# AMICODE_SMOKE iters=3 drives=1 knots=6 fidelity=0.9981 dt=0.5 delay_ms=40

# -- template-shaped parameter block (documentation of the modeled solve) --
# levels    = 8        # cavity Fock truncation (smoke-scale)
# drive_max = 0.2      # drive bound
# T         = 30.0     # pulse time (ns)
# N         = 6        # spline knots (smoke-scale)
# max_iter  = 3        # smoke-scale
# target    = displacement |0⟩ → |α⟩, α = 1.0
