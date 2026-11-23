# Pinned, vetted Julia env (Piccolo 2.2 / DirectTrajOpt 0.11 / NamedTrajectories 0.9.4) bundled in the VSIX.

# Provisioned to ~/.amico/julia via `Pkg.instantiate()` (scripts/install.sh, or the "Amicode: Set up Julia" command).

# The floor is the vetted pulse-designer template's version probe; test/julia_env_pins.test.ts fails if this env drifts below it.

# A user env set up from an older pin is reported as out of date (healthcheck + agent setup state); re-running setup upgrades it in place.

# Regenerate: raise [compat] in Project.toml, then in a scratch copy run
#   julia --project=. -e 'using Pkg; Pkg.update(["Piccolo","DirectTrajOpt","NamedTrajectories","MadNLP"]; preserve=Pkg.PRESERVE_NONE); Pkg.instantiate()'
# and copy Project.toml + Manifest.toml back here. Verify with:
#   AMICO_TEST_JULIA_PROJECT=<scratch copy> pnpm --filter amicode run test:slow
