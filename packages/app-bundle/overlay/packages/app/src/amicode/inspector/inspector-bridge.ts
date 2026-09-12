import { createSignal, onCleanup } from "solid-js"

export type RunIteration = { runId: string; iter: number; objective: number; inf_pr: number; inf_du: number }
export type RunPulseMeta = { runId: string; drives: number; knots: number; labels: string[]; bounds: [number, number][]; interp?: string }
export type RunPulse = { runId: string; iter: number; dt: number; values: number[][] }
export type RunCompletion = { runId: string; fidelity: number; iterations: number; status: string }
export type RunBridgeMessage =
  | { kind: "run:iteration"; runId: string; iter: number; objective: number; inf_pr: number; inf_du: number }
  | { kind: "run:pulse-meta"; runId: string; drives: number; knots: number; labels: string[]; bounds: [number, number][]; interp?: string }
  | { kind: "run:pulse"; runId: string; iter: number; dt: number; values: number[][] }
  | { kind: "run:completion"; runId: string; fidelity: number; iterations: number; status: string }
  | { kind: "run:activate"; runId: string }
  | { kind: "run:timing"; runId: string; elapsed: number }
  | { kind: "run:label"; runId: string; label: string }

export type DeviceBridgeMessage =
  | { kind: "device:status"; device: string; status: unknown }
  | { kind: "device:actions"; device: string; actions: unknown[] }
  | { kind: "device:activate"; device: string }

export type InspectorMessage = RunBridgeMessage | DeviceBridgeMessage

type RunState = {
  label?: string
  iterations: RunIteration[]
  pulseMeta?: RunPulseMeta
  pulses: RunPulse[]
  completion?: RunCompletion
  timing?: number
}

export function createInspectorBridge() {
  const [runs, setRuns] = createSignal<Map<string, RunState>>(new Map())
  const [activeRunId, setActiveRunId] = createSignal<string | undefined>(undefined)
  const [devices, setDevices] = createSignal<Map<string, { status: unknown; actions: unknown[] }>>(new Map())
  const [activeDevice, setActiveDevice] = createSignal<string | undefined>(undefined)

  const onMessage = (e: MessageEvent) => {
    const d = e.data as InspectorMessage & { source?: string }
    if (!d || d.source !== "amicode") return
    switch (d.kind) {
      case "run:iteration": {
        setRuns((m) => {
          const n = new Map(m)
          const s = n.get(d.runId) ?? { iterations: [], pulses: [] }
          n.set(d.runId, { ...s, iterations: [...s.iterations, { runId: d.runId, iter: d.iter, objective: d.objective, inf_pr: d.inf_pr, inf_du: d.inf_du }] })
          return n
        })
        if (!activeRunId()) setActiveRunId(d.runId)
        break
      }
      case "run:pulse-meta":
        setRuns((m) => {
          const n = new Map(m)
          const s = n.get(d.runId) ?? { iterations: [], pulses: [] }
          n.set(d.runId, { ...s, pulseMeta: d })
          return n
        })
        break
      case "run:pulse":
        setRuns((m) => {
          const n = new Map(m)
          const s = n.get(d.runId) ?? { iterations: [], pulses: [] }
          n.set(d.runId, { ...s, pulses: [...s.pulses.slice(-200), d] })
          return n
        })
        break
      case "run:completion":
        setRuns((m) => {
          const n = new Map(m)
          const s = n.get(d.runId) ?? { iterations: [], pulses: [] }
          n.set(d.runId, { ...s, completion: d })
          return n
        })
        break
      case "run:activate":
        setActiveRunId(d.runId)
        break
      case "run:label":
        setRuns((m) => {
          const n = new Map(m)
          const s = n.get(d.runId) ?? { iterations: [], pulses: [] }
          n.set(d.runId, { ...s, label: d.label })
          return n
        })
        break
      case "run:timing":
        setRuns((m) => {
          const n = new Map(m)
          const s = n.get(d.runId) ?? { iterations: [], pulses: [] }
          n.set(d.runId, { ...s, timing: d.elapsed })
          return n
        })
        break
      case "device:status":
        setDevices((m) => {
          const n = new Map(m)
          const cur = n.get(d.device) ?? { status: undefined, actions: [] }
          n.set(d.device, { ...cur, status: d.status })
          return n
        })
        if (!activeDevice()) setActiveDevice(d.device)
        break
      case "device:actions":
        setDevices((m) => {
          const n = new Map(m)
          const cur = n.get(d.device) ?? { status: undefined, actions: [] }
          n.set(d.device, { ...cur, actions: d.actions })
          return n
        })
        break
      case "device:activate":
        setActiveDevice(d.device)
        break
    }
  }

  window.addEventListener("message", onMessage)
  onCleanup(() => window.removeEventListener("message", onMessage))

  return { runs, activeRunId, setActiveRunId, devices, activeDevice, setActiveDevice }
}
