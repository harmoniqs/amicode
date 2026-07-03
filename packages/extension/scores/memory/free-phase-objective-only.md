# Free phases live in the objective, never the dynamics

When a target is defined up to one or more free phases (e.g. a unitary target
where relative phase on some subspace is unphysical or absorbable), those phase
variables enter the **objective only** — they parameterize the infidelity being
minimized. They never appear in the Hamiltonian or the ODE being integrated:
the dynamics are fixed physics; the free phase is a statement about what counts
as success. Optimizing "with free phase" means the objective searches over the
phase at evaluation time — the rollout is unchanged.
