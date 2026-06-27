#!/usr/bin/env julia
# 0.1d Julia round-trip test (fast tier — golden + negative fixtures, no solve).
# Proves the Julia validator honors the SAME shared schemas the TS side uses, and
# that mutating those single-source files would flip Julia too (anti-drift, #18 AC6).
#   julia --project=packages/schema/julia packages/schema/julia/runtests.jl
# A top-level @testset throws on failure → nonzero exit → reds CI.
using Test
include(joinpath(@__DIR__, "validate.jl"))
using .AmicoValidate: validate_file, SCHEMA_DIR

const FIX = normpath(joinpath(@__DIR__, "..", "test", "fixtures"))
const KINDS = ["manifest", "result", "lab", "solvespec", "catalog-entry", "finished"]

@testset "0.1d Julia round-trip against the shared schemas" begin
    @testset "valid golden corpus conforms" begin
        for k in KINDS
            @test validate_file(joinpath(FIX, "valid", "$k.toml"), k) === nothing
        end
    end

    @testset "invalid corpus → field-precise errors" begin
        # each negative names the offending key/path (the lab-partner promise, S16)
        @test occursin("run_id",           validate_file(joinpath(FIX, "invalid", "manifest.toml"), "manifest"))
        @test occursin("schema_version",   validate_file(joinpath(FIX, "invalid", "result.toml"), "result"))
        @test occursin("/transmon/levels", validate_file(joinpath(FIX, "invalid", "lab.toml"), "lab"))
        @test occursin("pulse_path",       validate_file(joinpath(FIX, "invalid", "catalog-entry.toml"), "catalog-entry"))
        @test occursin("/status",          validate_file(joinpath(FIX, "invalid", "finished.toml"), "finished"))
        @test validate_file(joinpath(FIX, "invalid", "solvespec.toml"), "solvespec") !== nothing
    end

    @testset "schema_version policy" begin
        mktempdir() do d
            absent = joinpath(d, "r.toml"); write(absent, "fidelity = 0.99\niterations = 60\n")
            @test occursin("schema_version", validate_file(absent, "result"))
            bad = joinpath(d, "b.toml"); write(bad, "schema_version = \"9\"\nfidelity = 0.99\niterations = 60\n")
            @test occursin("unrecognized version", validate_file(bad, "result"))
        end
    end

    @testset "unquoted TOML datetime is tolerated (S2)" begin
        mktempdir() do d
            f = joinpath(d, "manifest.toml")
            write(f, "schema_version = \"1\"\nrun_id=\"r\"\nscript_path=\"/s\"\nlab=\"d\"\nlab_id=\"d\"\n" *
                     "created_at=2026-06-15T00:00:00Z\norchestrator_version=\"0.1.0\"\n[julia]\nbinary=\"julia\"\n")
            @test validate_file(f, "manifest") === nothing
        end
    end

    @testset "the real bundled demo run dir (emitted golden) validates" begin
        demo = normpath(joinpath(@__DIR__, "..", "..", "extension", "demo", "run"))
        @test validate_file(joinpath(demo, "manifest.toml"), "manifest") === nothing
        @test validate_file(joinpath(demo, "result.toml"), "result") === nothing
        @test validate_file(joinpath(demo, "FINISHED"), "finished") === nothing
    end

    @testset "single source of truth (anti-drift, #18 AC6)" begin
        # The Julia validator reads the SAME files the TS validator imports — the
        # package's schemas/ dir — not a copy. Mutating one would flip both sides.
        @test basename(SCHEMA_DIR) == "schemas"
        @test isfile(joinpath(SCHEMA_DIR, "manifest.schema.json"))
        @test normpath(SCHEMA_DIR) == normpath(joinpath(@__DIR__, "..", "schemas"))
        # No transcribed schema copy lives in the Julia tree.
        @test isempty(filter(f -> endswith(f, ".schema.json"), readdir(@__DIR__)))
    end
end
