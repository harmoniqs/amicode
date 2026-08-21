import { createContext, useContext, type ParentProps } from "solid-js"
import { createInspectorBridge } from "./inspector-bridge"

type InspectorBridge = ReturnType<typeof createInspectorBridge>

const InspectorContext = createContext<InspectorBridge>()

export function InspectorProvider(props: ParentProps) {
  const bridge = createInspectorBridge()
  return <InspectorContext.Provider value={bridge}>{props.children}</InspectorContext.Provider>
}

export function useInspectorBridge(): InspectorBridge {
  const ctx = useContext(InspectorContext)
  if (!ctx) throw new Error("useInspectorBridge must be used within an InspectorProvider")
  return ctx
}
