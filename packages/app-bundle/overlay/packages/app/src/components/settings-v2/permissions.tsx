import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { showToast } from "@/utils/toast"
import { createMemo, createSignal, For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useModels } from "@/context/models"
import "./settings-v2.css"

type Effect = "allow" | "deny" | "ask"
type DirectoryPermissions = { read: Effect; write: Effect; execute: Effect; network: Effect }
type TrustTier = { id: string; label: string; directories: Record<string, DirectoryPermissions> }
type ProviderPermissionsConfig = { defaultTier: string; tiers: TrustTier[]; assignments: Record<string, string> }

const DEFAULT_TIERS: TrustTier[] = [
  { id: "trusted", label: "Trusted", directories: { "**": { read: "allow", write: "allow", execute: "allow", network: "allow" } } },
  { id: "limited", label: "Limited", directories: { "**": { read: "allow", write: "deny", execute: "deny", network: "deny" }, "~/secrets/**": { read: "deny", write: "deny", execute: "deny", network: "deny" } } },
  { id: "untrusted", label: "Untrusted", directories: { "**": { read: "deny", write: "deny", execute: "deny", network: "deny" } } },
  { id: "unassigned", label: "Unassigned", directories: { "**": { read: "ask", write: "ask", execute: "ask", network: "ask" } } },
]
const DEFAULT_CONFIG: ProviderPermissionsConfig = { defaultTier: "unassigned", tiers: DEFAULT_TIERS, assignments: {} }

const EFFECTS: Effect[] = ["allow", "deny", "ask"]
const EFFECT_LABEL: Record<Effect, string> = { allow: "Allow", deny: "Deny", ask: "Ask" }
const ACTION_GROUPS = ["read", "write", "execute", "network"] as const
type ActionGroup = (typeof ACTION_GROUPS)[number]
const GROUP_LABEL: Record<ActionGroup, string> = { read: "Read", write: "Write", execute: "Execute", network: "Network" }
const GROUP_TOOLS: Record<ActionGroup, string> = { read: "read, glob, grep", write: "write, edit", execute: "bash", network: "webfetch, websearch" }

function tierSummary(tier: TrustTier): string {
  const wildcard = tier.directories["**"]
  if (wildcard) {
    const vals = Object.values(wildcard)
    if (vals.every((v) => v === "allow")) return "Full Access"
    if (vals.every((v) => v === "ask")) return "Ask Everything"
    if (vals.every((v) => v === "deny")) return "No Access"
    if (wildcard.read === "allow" && wildcard.write === "deny" && wildcard.execute === "deny" && wildcard.network === "deny") return "Read Only"
  }
  const all = Object.values(tier.directories)
  const flat = all.flatMap((d) => Object.values(d))
  if (flat.every((v) => v === "allow")) return "Full Access"
  if (flat.every((v) => v === "deny")) return "No Access"
  if (flat.every((v) => v === "ask")) return "Ask Everything"
  const allReadAllow = all.every((d) => d.read === "allow")
  const allOtherDeny = all.every((d) => d.write === "deny" && d.execute === "deny" && d.network === "deny")
  if (allReadAllow && allOtherDeny) return "Read Only"
  return "Custom"
}

function badgeVariant(summary: string): "danger" | "warning" | "neutral" | "info" {
  if (summary === "Full Access") return "danger"
  if (summary === "No Access") return "neutral"
  if (summary === "Read Only") return "info"
  if (summary === "Ask Everything") return "neutral"
  return "warning"
}

export const SettingsPermissionsV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const modelsCtx = useModels()

  const rawConfig = createMemo(() => {
    const raw = (serverSync().data.config as Record<string, unknown>).providerPermissions as ProviderPermissionsConfig | undefined
    if (!raw || !Array.isArray(raw.tiers)) return DEFAULT_CONFIG
    // ensure unassigned exists
    const hasUnassigned = raw.tiers.some((t) => t.id === "unassigned")
    if (!hasUnassigned) return { ...raw, tiers: [...raw.tiers, DEFAULT_TIERS[3]] }
    return raw
  })

  const tiers = createMemo(() => rawConfig().tiers)
  const assignments = createMemo(() => rawConfig().assignments)
  const defaultTier = createMemo(() => rawConfig().defaultTier)

  const allModels = createMemo(() => {
    try {
      return modelsCtx.list().map((m) => `${m.provider.id}/${m.id}`)
    } catch {
      return [] as string[]
    }
  })

  const modelsByTier = createMemo(() => {
    const map = new Map<string, string[]>()
    for (const tier of tiers()) map.set(tier.id, [])
    for (const [modelId, tierId] of Object.entries(assignments())) {
      const arr = map.get(tierId)
      if (arr) arr.push(modelId)
      else map.set(tierId, [modelId])
    }
    return map
  })

  const unassignedModels = createMemo(() => {
    const assigned = new Set(Object.keys(assignments()))
    return allModels().filter((m) => !assigned.has(m))
  })

  const persist = async (next: ProviderPermissionsConfig) => {
    const before = rawConfig()
    // optimistic — cast through unknown to satisfy Config Part typing (providerPermissions is valid Config key)
    ;(serverSync() as unknown as { set: (...a: unknown[]) => void }).set("config", "providerPermissions", next)
    try {
      await (serverSync() as unknown as { updateConfig: (c: unknown) => Promise<void> }).updateConfig({
        providerPermissions: next,
      })
      showToast({ variant: "success", title: language.t("settings.permissions.toast.saved") ?? "Permissions saved" })
    } catch (e) {
      ;(serverSync() as unknown as { set: (...a: unknown[]) => void }).set("config", "providerPermissions", before)
      showToast({ title: language.t("common.requestFailed"), description: e instanceof Error ? e.message : String(e) })
    }
  }

  const updateTier = (tierId: string, updater: (t: TrustTier) => TrustTier) => {
    const nextTiers = tiers().map((t) => (t.id === tierId ? updater(t) : t))
    void persist({ ...rawConfig(), tiers: nextTiers })
  }

  const addTier = () => {
    const id = `tier_${Date.now().toString(36)}`
    const newTier: TrustTier = { id, label: "New Tier", directories: { "**": { read: "ask", write: "ask", execute: "ask", network: "ask" } } }
    void persist({ ...rawConfig(), tiers: [...tiers(), newTier] })
  }

  const deleteTier = (tierId: string) => {
    if (tierId === "unassigned") return
    const nextTiers = tiers().filter((t) => t.id !== tierId)
    const nextAssignments = { ...assignments() }
    for (const [model, tid] of Object.entries(nextAssignments)) {
      if (tid === tierId) delete nextAssignments[model]
    }
    void persist({ defaultTier: defaultTier() === tierId ? "unassigned" : defaultTier(), tiers: nextTiers, assignments: nextAssignments })
  }

  const moveTier = (tierId: string, dir: -1 | 1) => {
    const idx = tiers().findIndex((t) => t.id === tierId)
    if (idx < 0) return
    const nextIdx = idx + dir
    if (nextIdx < 0 || nextIdx >= tiers().length) return
    const next = [...tiers()]
    const [moved] = next.splice(idx, 1)
    next.splice(nextIdx, 0, moved)
    void persist({ ...rawConfig(), tiers: next })
  }

  const assignModel = (modelId: string, tierId: string) => {
    const nextAssignments = { ...assignments() }
    // remove from previous
    for (const [mid, tid] of Object.entries(nextAssignments)) {
      if (mid === modelId) delete nextAssignments[mid]
    }
    if (tierId !== "unassigned") nextAssignments[modelId] = tierId
    else delete nextAssignments[modelId]
    void persist({ ...rawConfig(), assignments: nextAssignments })
  }

  const updateDirectoryEffect = (tierId: string, pattern: string, group: ActionGroup, effect: Effect) => {
    updateTier(tierId, (t) => ({
      ...t,
      directories: { ...t.directories, [pattern]: { ...t.directories[pattern], [group]: effect } },
    }))
  }

  const addDirectoryRule = (tierId: string) => {
    const tier = tiers().find((t) => t.id === tierId)
    if (!tier) return
    let pattern = "folder/**"
    for (let n = 2; tier.directories[pattern]; n++) pattern = `folder-${n}/**`
    updateTier(tierId, (t) => ({
      ...t,
      directories: { ...t.directories, [pattern]: { read: "deny", write: "deny", execute: "deny", network: "deny" } },
    }))
    setEditingPattern(`${tierId}:${pattern}`)
    setPatternValue(pattern)
  }

  const renameDirectoryRule = (tierId: string, from: string, to: string) => {
    const next = to.trim()
    if (!next || next === from || next === "**") return
    updateTier(tierId, (t) => {
      if (!t.directories[from] || t.directories[next]) return t
      const directories: Record<string, DirectoryPermissions> = {}
      for (const [k, v] of Object.entries(t.directories)) directories[k === from ? next : k] = v
      return { ...t, directories }
    })
  }

  const removeDirectoryRule = (tierId: string, pattern: string) => {
    if (pattern === "**") return
    updateTier(tierId, (t) => {
      const next = { ...t.directories }
      delete next[pattern]
      return { ...t, directories: next }
    })
  }

  const [editingLabel, setEditingLabel] = createSignal<string | null>(null)
  const [editValue, setEditValue] = createSignal("")
  // exception pattern being edited, keyed `${tierId}:${pattern}`
  const [editingPattern, setEditingPattern] = createSignal<string | null>(null)
  const [patternValue, setPatternValue] = createSignal("")

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked settings-v2-permissions-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.permissions.title") ?? "Permissions"}</h2>
          <ButtonV2 size="small" variant="neutral" icon="plus" onClick={addTier}>
            {language.t("settings.permissions.action.addTier") ?? "Add tier"}
          </ButtonV2>
        </div>
        <p class="settings-v2-permissions-intro">
          {language.t("settings.permissions.description") ?? "Trust tiers control which directories and actions each model can access. Assigned models inherit their tier's matrix; unassigned models use Unassigned."}
        </p>
      </div>

      <div class="settings-v2-tab-body settings-v2-permissions" data-component="permissions-tab">
        <For each={tiers()}>
          {(tier) => {
            const summary = () => tierSummary(tier)
            const isUnassigned = () => tier.id === "unassigned"
            const assignedModels = () => modelsByTier().get(tier.id) ?? []
            const exceptions = () => Object.entries(tier.directories).filter(([p]) => p !== "**")

            const renderRule = (t: TrustTier, pattern: string, perms: DirectoryPermissions) => {
              const isDefault = pattern === "**"
              const editKey = `${t.id}:${pattern}`
              const commitPattern = () => {
                renameDirectoryRule(t.id, pattern, patternValue())
                setEditingPattern(null)
              }
              return (
                <div class="settings-v2-permissions-rule" data-default={isDefault ? "" : undefined}>
                  <Show
                    when={isDefault}
                    fallback={
                      <Show
                        when={editingPattern() === editKey}
                        fallback={
                          <button
                            type="button"
                            class="settings-v2-permissions-matrix-pattern"
                            title="Edit pattern"
                            onClick={() => { setEditingPattern(editKey); setPatternValue(pattern) }}
                          >
                            {pattern}
                          </button>
                        }
                      >
                        <TextInputV2
                          class="settings-v2-permissions-pattern-input"
                          value={patternValue()}
                          placeholder="e.g. ~/secrets/**"
                          onInput={(e) => setPatternValue(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitPattern()
                            if (e.key === "Escape") setEditingPattern(null)
                          }}
                          onBlur={commitPattern}
                          // eslint-disable-next-line jsx-a11y/no-autofocus
                          autofocus
                        />
                      </Show>
                    }
                  >
                    <span
                      class="settings-v2-permissions-matrix-pattern settings-v2-permissions-matrix-pattern--default"
                      title="Applies to every directory unless a folder exception matches"
                    >
                      Everywhere
                    </span>
                  </Show>
                  <For each={ACTION_GROUPS}>{(group) => {
                    const effect = () => perms[group]
                    const isDanger = () => (group === "execute" || group === "network") && effect() === "allow"
                    return (
                      <div class="settings-v2-permissions-matrix-cell" data-group={group} data-danger={isDanger() ? "" : undefined}>
                        <span class="settings-v2-permissions-matrix-cell-label" title={GROUP_TOOLS[group]}>
                          {GROUP_LABEL[group]}
                        </span>
                        <SelectV2
                          appearance="inline"
                          options={EFFECTS}
                          current={effect()}
                          placement="bottom-end"
                          gutter={6}
                          label={(o) => EFFECT_LABEL[o]}
                          valueClass={isDanger() ? "settings-v2-permissions-effect--danger" : undefined}
                          onSelect={(o) => o && updateDirectoryEffect(t.id, pattern, group, o)}
                        />
                      </div>
                    )
                  }}</For>
                  <Show when={!isDefault} fallback={<span class="settings-v2-permissions-matrix-remove" aria-hidden="true" />}>
                    <ButtonV2
                      size="small"
                      variant="ghost-muted"
                      icon="xmark-small"
                      class="settings-v2-permissions-matrix-remove"
                      aria-label={`Remove exception ${pattern}`}
                      title="Remove exception"
                      onClick={() => removeDirectoryRule(t.id, pattern)}
                    />
                  </Show>
                </div>
              )
            }
            return (
              <div class="settings-v2-permissions-card" data-tier-id={tier.id}>
                <div class="settings-v2-permissions-card-header">
                  <div class="settings-v2-permissions-card-title-row">
                    <Show
                      when={editingLabel() === tier.id}
                      fallback={
                        <>
                          <h3 class="settings-v2-permissions-card-title">{tier.label}</h3>
                          <Tag
                            variant={badgeVariant(summary()) === "danger" ? "accent" : "neutral"}
                            class="settings-v2-permissions-badge"
                            title={summary() === "Full Access" ? "Every action is allowed everywhere" : undefined}
                          >
                            {summary()}
                          </Tag>
                          <Show when={!isUnassigned()}>
                            <ButtonV2
                              size="small"
                              variant="ghost-muted"
                              icon="edit"
                              aria-label={language.t("common.rename") ?? "Rename"}
                              title={language.t("common.rename") ?? "Rename"}
                              onClick={() => { setEditingLabel(tier.id); setEditValue(tier.label) }}
                            />
                          </Show>
                        </>
                      }
                    >
                      <TextInputV2
                        value={editValue()}
                        onInput={(e) => setEditValue(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            updateTier(tier.id, (t) => ({ ...t, label: editValue().trim() || t.label }))
                            setEditingLabel(null)
                          }
                          if (e.key === "Escape") setEditingLabel(null)
                        }}
                        onBlur={() => {
                          if (editValue().trim()) updateTier(tier.id, (t) => ({ ...t, label: editValue().trim() }))
                          setEditingLabel(null)
                        }}
                        // eslint-disable-next-line jsx-a11y/no-autofocus
                        autofocus
                      />
                      <ButtonV2 size="small" variant="neutral" onClick={() => { updateTier(tier.id, (t) => ({ ...t, label: editValue().trim() || t.label })); setEditingLabel(null) }}>
                        Save
                      </ButtonV2>
                    </Show>
                  </div>
                  <div class="settings-v2-permissions-card-actions">
                    <ButtonV2
                      size="small"
                      variant="ghost-muted"
                      aria-label="Move tier up"
                      disabled={tiers().indexOf(tier) === 0}
                      onClick={() => moveTier(tier.id, -1)}
                    >
                      ↑
                    </ButtonV2>
                    <ButtonV2
                      size="small"
                      variant="ghost-muted"
                      aria-label="Move tier down"
                      disabled={tiers().indexOf(tier) === tiers().length - 1}
                      onClick={() => moveTier(tier.id, 1)}
                    >
                      ↓
                    </ButtonV2>
                    <Show when={!isUnassigned()}>
                      <ButtonV2 size="small" variant="ghost-muted" onClick={() => deleteTier(tier.id)}>
                        {language.t("common.delete") ?? "Delete"}
                      </ButtonV2>
                    </Show>
                  </div>
                </div>

                {/* Default permissions ("Everywhere" = the ** rule) + folder exceptions */}
                <div class="settings-v2-permissions-matrix">
                  <div class="settings-v2-permissions-matrix-header" aria-hidden="true">
                    <span class="settings-v2-permissions-matrix-corner">Directory</span>
                    <For each={ACTION_GROUPS}>{(g) => (
                      <span class="settings-v2-permissions-matrix-head" data-group={g} title={GROUP_TOOLS[g]}>
                        {GROUP_LABEL[g]}
                      </span>
                    )}</For>
                    <span class="settings-v2-permissions-matrix-head settings-v2-permissions-matrix-head-actions" />
                  </div>
                  <Show when={tier.directories["**"]}>{(perms) => renderRule(tier, "**", perms())}</Show>
                  <Show when={exceptions().length > 0}>
                    <h5 class="settings-v2-permissions-group-label">Folder exceptions</h5>
                    <For each={exceptions()}>{([pattern, perms]) => renderRule(tier, pattern, perms)}</For>
                  </Show>
                  <ButtonV2 size="small" variant="ghost-muted" icon="plus" onClick={() => addDirectoryRule(tier.id)}>
                    Add folder exception
                  </ButtonV2>
                  <p class="settings-v2-permissions-matrix-help">
                    Exceptions override the defaults for matching folders. Glob patterns, e.g. ~/secrets/**, src/private/**. Most-specific pattern wins.
                  </p>
                </div>

                {/* Model Assignment — multi-select picker inside tier card */}
                <div class="settings-v2-permissions-models">
                  <h4 class="settings-v2-permissions-models-title">Models in this tier</h4>
                  <Show when={assignedModels().length > 0} fallback={<p class="settings-v2-permissions-models-empty">No models assigned</p>}>
                    <div class="settings-v2-permissions-models-list">
                      <For each={assignedModels()}>{(mid) => (
                        <span class="settings-v2-permissions-model-chip">
                          {mid}
                          <button type="button" class="settings-v2-permissions-model-remove" aria-label={`Unassign ${mid}`} onClick={() => assignModel(mid, "unassigned")}>×</button>
                        </span>
                      )}</For>
                    </div>
                  </Show>
                  <div class="settings-v2-permissions-model-picker" data-component="model-multi-picker">
                    <p class="settings-v2-permissions-model-picker-help">
                      {language.t("settings.permissions.modelPicker.help") ??
                        "Check to assign — a model can only be in one tier; checking here removes it from its previous tier."}
                    </p>
                    <div class="settings-v2-permissions-model-grid">
                      <For each={allModels()}>
                        {(m) => {
                          const checked = () =>
                            tier.id === "unassigned" ? !assignments()[m] : assignments()[m] === tier.id
                          return (
                            <label class="settings-v2-permissions-model-option">
                              <input
                                type="checkbox"
                                checked={checked()}
                                onChange={(e) =>
                                  e.currentTarget.checked ? assignModel(m, tier.id) : assignModel(m, "unassigned")
                                }
                              />
                              <span class="settings-v2-permissions-model-option-label">{m}</span>
                            </label>
                          )
                        }}
                      </For>
                    </div>
                    <Show when={allModels().length === 0}>
                      <span class="settings-v2-permissions-models-hint">No models available — connect a provider first.</span>
                    </Show>
                  </div>
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </>
  )
}
