# Shared run-dir emit helper: writes the pre-solve `formulation.toml`.
#
# This is the ANTI-DRIFT mechanism for the run-dir contract's problem-definition
# file. Every solve template should `include` this and call `emit_formulation`
# rather than open-coding a `TOML.print`, so the [system]/[formulation] shape
# stays identical across templates (the base transmon template, the pulse-designer
# template, Aaron's rydberg template #75/#76, the smoke corpus #78, ...).
#
# The file is written into the run dir (the script's cwd) BEFORE `solve!`, mirroring
# the atomic temp-then-rename idiom of the post-solve `result.toml` emit. It carries
# only the DECLARED problem — the labels + physical params — so it is the clean,
# authoritative identity source #64's hashing keys off (System÷Formulation split).
#
# Labels cannot be reverse-derived from the Julia objects (`GATES[:X]` is a matrix;
# `TransmonSystem(...)` is a struct whose "transmon"-ness is its type), so the
# caller passes them explicitly.
#
# Contract (validated by @amicode/schema formulation.schema.json):
#   schema_version = "1"
#   [system]       family (required) + optional name + family-dependent params
#   [formulation]  gate (required) + T/N/Q/R + any family-dependent extras
#
# `system_params` / `formulation_extra` are merged in leniently (the schema treats
# leaf fields as additionalProperties per family), so a Rydberg caller can pass
# `Omega_max`/`C6`/... without a base-template change.

using TOML

function emit_formulation(;
    system_family::AbstractString,
    gate_name::AbstractString,
    system_params::AbstractDict = Dict{String,Any}(),
    system_name::Union{AbstractString,Nothing} = nothing,
    formulation_extra::AbstractDict = Dict{String,Any}(),
    path::AbstractString = "formulation.toml",
)
    system = Dict{String,Any}("family" => String(system_family))
    if system_name !== nothing
        system["name"] = String(system_name)
    end
    for (k, v) in system_params
        system[String(k)] = v
    end

    formulation = Dict{String,Any}("gate" => String(gate_name))
    for (k, v) in formulation_extra
        formulation[String(k)] = v
    end

    doc = Dict{String,Any}(
        "schema_version" => "1",   # run-dir contract version (@amicode/schema formulation schema)
        "system" => system,
        "formulation" => formulation,
    )

    tmp = path * ".tmp"
    open(tmp, "w") do io
        TOML.print(io, doc)
    end
    mv(tmp, path; force = true)   # atomic swap — a partial read never sees a half-written file
    return path
end
