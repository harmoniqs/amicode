#!/usr/bin/env julia
# amico-validate, Julia side (0.1d). Validates a TOML artifact against the SAME
# shared JSON Schema files the TS validator uses — read DIRECTLY from
# ../schemas/*.json, never a transcribed copy (that single source is what makes
# the cross-language anti-drift guarantee real: mutate a schema → both sides flip).
#
# Usage:  julia --project=packages/schema/julia validate.jl <file> [kind]
#   kind inferred from basename for manifest.toml/result.toml/lab.toml/FINISHED.
# Exit:   0 valid · 64 invalid or usage error (mirrors amico-validate / amico-run).
module AmicoValidate

import TOML
import JSON
import Dates
using JSONSchema

const SCHEMA_DIR = normpath(joinpath(@__DIR__, "..", "schemas"))

kind_for_filename(path) = begin
    b = basename(path)
    b == "manifest.toml" ? "manifest" :
    b == "result.toml"   ? "result"   :
    b == "lab.toml"      ? "lab"       :
    b == "FINISHED"      ? "finished"  : nothing
end

schema_path(kind) = joinpath(SCHEMA_DIR, "$(kind).schema.json")
load_schema(kind) = Schema(read(schema_path(kind), String))

# Allowed property names at a JSON-pointer path within the schema — so the
# additionalProperties shim can NAME the offending extra key (JSONSchema.jl only
# reports `false`, not which key), matching the TS validator.
function allowed_props(schema, parts)
    node = schema
    for p in parts
        node = get(get(node, "properties", Dict{String,Any}()), p, Dict{String,Any}())
    end
    Set(string.(keys(get(node, "properties", Dict{String,Any}()))))
end

# TOML → JSON-compatible: an UNQUOTED TOML datetime parses to a Dates type, which
# would fail `type: string` (format: date-time). Coerce to ISO-8601 so quoted and
# unquoted datetimes validate identically (matches the TS validateFile S2 fix).
jsonify(x) = x
jsonify(d::AbstractDict) = Dict(string(k) => jsonify(v) for (k, v) in d)
jsonify(a::AbstractVector) = Any[jsonify(v) for v in a]
jsonify(t::Dates.TimeType) = string(t)

# Shim JSONSchema.jl's SingleIssue into a field-precise message comparable to the
# TS side ("/path/to/key: reason"). Its `path` is like "[a][b]" or "" (root);
# `reason` is the failing keyword; `x` is the failing instance; `val` the schema
# fragment. For `required`/`enum` we reconstruct the offending key from x/val.
function format_issue(iss, schema)
    parts = [String(p) for p in split(iss.path, ['[', ']']) if !isempty(p)]
    where = isempty(parts) ? "(root)" : "/" * join(parts, "/")
    r = iss.reason
    if r == "required"
        present = try Set(string.(keys(iss.x))) catch; Set{String}() end
        missing = String[string(k) for k in iss.val if !(string(k) in present)]
        return "$where: missing required key " * (isempty(missing) ? "(unknown)" : join(["\"$k\"" for k in missing], ", "))
    elseif r == "additionalProperties"
        extra = try String[string(k) for k in keys(iss.x) if !(string(k) in allowed_props(schema, parts))] catch; String[]; end
        return "$where: unknown key " * (isempty(extra) ? "(unexpected)" : join(["\"$k\"" for k in extra], ", "))
    elseif r == "enum"
        endswith(where, "schema_version") && return "/schema_version: unrecognized version"
        return "$where: must be one of (" * join(string.(iss.val), ", ") * ")"
    elseif r == "type"
        return "$where: must be $(iss.val)"
    elseif r == "maximum"
        return "$where: must be <= $(iss.val)"
    elseif r == "minimum"
        return "$where: must be >= $(iss.val)"
    elseif r == "exclusiveMinimum"
        return "$where: must be > $(iss.val)"
    elseif r == "minLength"
        return "$where: must be a non-empty string"
    else
        return "$where: $r"
    end
end

"""Validate `path` (TOML) against the shared schema for `kind`.
Returns `nothing` if valid, else a field-precise error String."""
function validate_file(path::AbstractString, kind::AbstractString)
    data = jsonify(TOML.parsefile(path))
    iss = JSONSchema.validate(load_schema(kind), data)
    iss === nothing && return nothing
    format_issue(iss, JSON.parsefile(schema_path(kind)))
end

function main(args)
    if isempty(args) || args[1] in ("-h", "--help")
        println("usage: julia validate.jl <file> [kind]"); return isempty(args) ? 64 : 0
    end
    file = args[1]
    kind = length(args) >= 2 ? args[2] : kind_for_filename(file)
    if kind === nothing
        println(stderr, "amico-validate(jl): cannot infer schema for $file — pass a kind"); return 64
    end
    err = try
        validate_file(file, kind)
    catch e
        println(stderr, "amico-validate(jl): $file: $(sprint(showerror, e))"); return 64
    end
    if err === nothing
        println("OK $file ($kind)"); return 0
    else
        println(stderr, "INVALID $file ($kind):\n  $err"); return 64
    end
end

end # module

if abspath(PROGRAM_FILE) == @__FILE__
    exit(AmicoValidate.main(ARGS))
end
