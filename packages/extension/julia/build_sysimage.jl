# Build the amico sysimage: bake Piccolo + CairoMakie (+ JLD2/TOML/Printf) and
# the solve/plot code paths into a native image so amico-run starts a solve in
# seconds instead of paying ~100s of Julia/Makie compilation on the first run.
#
# Run with PackageCompiler available (install.sh adds it to the global env):
#   AMICO_JULIA_PROJECT=~/.amico/julia julia build_sysimage.jl
#
# Output: <project>/amico-sysimage.{dylib|so} — amico-run auto-detects it.
using PackageCompiler

const PROJECT = get(ENV, "AMICO_JULIA_PROJECT", joinpath(homedir(), ".amico", "julia"))
const HERE = @__DIR__
const SYSIMG = joinpath(PROJECT, Sys.isapple() ? "amico-sysimage.dylib" : "amico-sysimage.so")
const EXERCISE = joinpath(HERE, "sysimage_exercise.jl")

@info "building amico sysimage" project=PROJECT output=SYSIMG
# Only direct, non-stdlib project deps go in the package list; Printf et al. are
# pure stdlibs (always in the sysimage) and their methods get baked via the
# precompile-execution trace. cpu_target left at PackageCompiler's default
# (native to the build machine, which is where install.sh runs it).
create_sysimage(
    [:Piccolo, :CairoMakie, :JLD2, :TOML];
    project = PROJECT,
    sysimage_path = SYSIMG,
    precompile_execution_file = EXERCISE,
)
@info "sysimage built" path=SYSIMG bytes=(isfile(SYSIMG) ? filesize(SYSIMG) : 0)
