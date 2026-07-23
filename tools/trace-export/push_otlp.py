#!/usr/bin/env python3
"""
Push an OTLP-JSON trace file (produced by otlp_export.py) to an OTLP/HTTP
protobuf collector such as Phoenix (:6006/v1/traces).

Phoenix only accepts application/x-protobuf, and OTLP/JSON encodes trace/span
ids as hex (not base64), so we build the protobuf message by hand from the JSON.

Run with a python that has opentelemetry-proto installed, e.g. the Phoenix venv:
  /home/jack/.venv/bin/python3 push_otlp.py <file.otlp.json> [endpoint]
"""
import json, sys, os, base64, urllib.request
from opentelemetry.proto.collector.trace.v1 import trace_service_pb2 as ts
from opentelemetry.proto.trace.v1 import trace_pb2 as tp
from opentelemetry.proto.common.v1 import common_pb2 as cp
from opentelemetry.proto.resource.v1 import resource_pb2 as rp

STATUS = {"STATUS_CODE_OK": 1, "STATUS_CODE_ERROR": 2, "STATUS_CODE_UNSET": 0}


def any_value(v):
    av = cp.AnyValue()
    if "stringValue" in v:   av.string_value = v["stringValue"]
    elif "intValue" in v:    av.int_value = int(v["intValue"])
    elif "doubleValue" in v: av.double_value = float(v["doubleValue"])
    elif "boolValue" in v:   av.bool_value = bool(v["boolValue"])
    else:                    av.string_value = ""
    return av


def kvs(attrs):
    out = []
    for a in attrs:
        kv = cp.KeyValue(key=a["key"])
        kv.value.CopyFrom(any_value(a["value"]))
        out.append(kv)
    return out


def build_request(doc):
    req = ts.ExportTraceServiceRequest()
    for rs in doc["resourceSpans"]:
        pb_rs = req.resource_spans.add()
        if "resource" in rs:
            pb_rs.resource.CopyFrom(rp.Resource(attributes=kvs(rs["resource"].get("attributes", []))))
        for ss in rs["scopeSpans"]:
            pb_ss = pb_rs.scope_spans.add()
            sc = ss.get("scope", {})
            pb_ss.scope.CopyFrom(cp.InstrumentationScope(name=sc.get("name", ""), version=sc.get("version", "")))
            for s in ss["spans"]:
                sp = pb_ss.spans.add()
                sp.trace_id = bytes.fromhex(s["traceId"])
                sp.span_id = bytes.fromhex(s["spanId"])
                if s.get("parentSpanId"):
                    sp.parent_span_id = bytes.fromhex(s["parentSpanId"])
                sp.name = s.get("name", "")
                sp.kind = s.get("kind", 1)
                sp.start_time_unix_nano = int(s["startTimeUnixNano"])
                sp.end_time_unix_nano = int(s["endTimeUnixNano"])
                sp.attributes.extend(kvs(s.get("attributes", [])))
                st = s.get("status", {})
                sp.status.code = STATUS.get(st.get("code", "STATUS_CODE_UNSET"), 0)
                if st.get("message"):
                    sp.status.message = st["message"]
    return req


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "ses_07a00202fffe0RtGsdRuaiOq9R.otlp.json"
    endpoint = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:6006/v1/traces"
    doc = json.load(open(path))
    req = build_request(doc)
    n = sum(len(ss.spans) for rs in req.resource_spans for ss in rs.scope_spans)
    body = req.SerializeToString()
    print(f"payload : {n} spans, {len(body)} bytes protobuf")
    headers = {"Content-Type": "application/x-protobuf"}
    # Optional Basic auth for Langfuse: OTLP_AUTH_BASIC="pk:sk"
    auth = os.environ.get("OTLP_AUTH_BASIC")
    if auth:
        headers["Authorization"] = "Basic " + base64.b64encode(auth.encode()).decode()
        print("auth    : Basic (from OTLP_AUTH_BASIC)")
    r = urllib.request.Request(endpoint, data=body, headers=headers)
    with urllib.request.urlopen(r, timeout=30) as resp:
        print(f"POST {endpoint}\nHTTP {resp.status} {resp.reason}")
        print("resp:", resp.read()[:200])


if __name__ == "__main__":
    main()
