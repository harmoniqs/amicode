# Smoke-corpus fixture (1.4a, #61) — FAILURE LANE: a solve that dies mid-run.
# Exercises the path a crashing Julia process takes end-to-end: nonzero exit →
# executor writes FINISHED{failed} → RunsManager registers terminal WITHOUT a
# fidelity (no result.toml is written on failure) → completion fans to the
# inspector runId-tagged → promote never fires.
#
# CI FIXTURE, not runnable physics — see transmon_x.jl for the mechanism
# (test/corpus/fake-julia interprets the directive below; exit=1 makes it
# emit two iterations of telemetry and then die, like a real mid-solve crash).
#
# AMICODE_SMOKE iters=2 drives=1 knots=4 exit=1 dt=0.2 delay_ms=40
