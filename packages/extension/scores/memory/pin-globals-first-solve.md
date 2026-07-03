# Pin global model parameters during the initial pulse solve

On a first solve, hold global model parameters (qubit frequency, anharmonicity,
coupling strengths) **fixed** and optimize the pulse alone. Co-optimizing
globals alongside the controls on a cold start lets the optimizer "explain
away" infidelity by drifting the model instead of shaping the pulse — you get
a great fidelity number against a system you no longer have. If model
parameters should move, make that a deliberate, separate step after the
pulse-only solve converges — never a silent default.
