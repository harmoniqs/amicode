# Unicycle environment

The shared setting for the tutorial experiments: a kinematic unicycle with state
`(x, y, heading)` and controls `(forward speed v, turn rate omega)`, sampled every
0.05 s. The experiments in `../../experiments/` inline these constants so each script
runs on its own; this page records what they mean.

| Quantity | Value |
|---|---|
| Reference | circle of radius 1 m around the origin, 0.5 rad/s (one lap in about 12.6 s) |
| Matched start | `(1.0, 0.0)` heading `pi/2` - exactly on the reference |
| Perturbed start | `(1.3, -0.2)` heading `pi/2 - 0.4` - off the reference |
| Speed range | 0 to 0.8 m/s |
| Turn-rate range | -1.5 to 1.5 rad/s |
