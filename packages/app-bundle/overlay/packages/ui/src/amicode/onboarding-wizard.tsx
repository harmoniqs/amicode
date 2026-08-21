import { For, Show, createSignal, onCleanup } from "solid-js"
import { Mark, MarkDetailed } from "../components/logo"
import {
  institutionLogoUrl,
  suggestInstitutions,
  resolveBrandLogo,
  type InstitutionSuggestion,
} from "./institution-lookup"
import { fileToBase64 } from "./upload"

// AMICODE: first-run onboarding wizard — the dedicated welcome UI (session
// zero, visual edition). Three steps: brand welcome → about-you (name, focus,
// institution with live logo lookup, Scholar) → preview + open chat. Saving
// goes through the SAME POST /amicode/profile the About-You card uses (the
// host passes onComplete), so the home page reflects it instantly and the
// chat's overture interview skips what's already answered.

export type WizardFields = {
  name: string
  affiliation: string
  focus: string
  scholar: string
  affiliation_logo: string
}

/** Show the wizard only for a genuinely fresh profile: nothing identity-like
 *  saved yet and no prior dismiss. Pure — unit-tested. */
export function shouldShowWizard(
  profile: { affiliation?: string | null; scholar?: string | null; focus?: string | null } | undefined,
  dismissed: boolean,
): boolean {
  if (dismissed || profile === undefined) return false
  return !profile.affiliation && !profile.scholar && !profile.focus
}

const LABEL: Record<string, string> = {
  "font-size": "11px",
  "font-weight": "650",
  "letter-spacing": "0.06em",
  "text-transform": "uppercase",
  color: "var(--v2-text-text-muted)",
  "margin-bottom": "4px",
}

export function AmicodeOnboardingWizard(props: {
  initialName?: string
  onComplete: (fields: WizardFields) => Promise<void>
  /** Optional: enables the library step (papers that make Amico smarter). */
  onUploadPaper?: (filename: string, dataB64: string) => Promise<void>
  /** Optional: enables the finale "attach your own vault" affordance. Given a
   *  reference (owner/repo, git URL, or a local path), resolves to the attached
   *  mount name; rejects with a human-readable message on failure. */
  onAttachVault?: (ref: string) => Promise<{ name: string }>
  onDismiss: () => void
  onOpenChat: () => void
}) {
  const [step, setStep] = createSignal<0 | 1 | 2 | 3>(0)
  const FINAL = 3
  // library step state (skipped entirely when onUploadPaper isn't wired)
  const [uploaded, setUploaded] = createSignal<string[]>([])
  const [uploadBusy, setUploadBusy] = createSignal(false)
  const [uploadError, setUploadError] = createSignal<string | undefined>(undefined)
  let paperInput: HTMLInputElement | undefined
  const uploadPapers = async (files: FileList | null) => {
    if (!files || files.length === 0 || !props.onUploadPaper) return
    setUploadBusy(true)
    setUploadError(undefined)
    try {
      for (const file of Array.from(files)) {
        await props.onUploadPaper(file.name, await fileToBase64(file))
        setUploaded([...uploaded(), file.name])
      }
    } catch {
      setUploadError("Upload failed — PDFs only, up to 30MB.")
    } finally {
      setUploadBusy(false)
      if (paperInput) paperInput.value = ""
    }
  }
  const [fields, setFields] = createSignal<WizardFields>({
    name: props.initialName ?? "",
    affiliation: "",
    focus: "",
    scholar: "",
    affiliation_logo: "",
  })
  const [suggestions, setSuggestions] = createSignal<InstitutionSuggestion[]>([])
  const [resolvingLogo, setResolvingLogo] = createSignal(0)
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | undefined>(undefined)

  // finale: attach-your-own-vault (skipped entirely when onAttachVault isn't wired)
  const [attachOpen, setAttachOpen] = createSignal(false)
  const [attachRef, setAttachRef] = createSignal("")
  const [attaching, setAttaching] = createSignal(false)
  const [attached, setAttached] = createSignal<string[]>([])
  const [attachError, setAttachError] = createSignal<string | undefined>(undefined)
  const attach = async () => {
    const ref = attachRef().trim()
    if (!ref || !props.onAttachVault) return
    setAttaching(true)
    setAttachError(undefined)
    try {
      const { name } = await props.onAttachVault(ref)
      setAttached([...attached(), name])
      setAttachRef("")
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : "Couldn't attach that vault.")
    } finally {
      setAttaching(false)
    }
  }

  // same debounce + out-of-order discipline as the About-You card
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchSeq = 0
  onCleanup(() => {
    if (searchTimer) clearTimeout(searchTimer)
  })
  const search = (q: string) => {
    if (searchTimer) clearTimeout(searchTimer)
    if (q.trim().length < 2) {
      searchSeq++
      setSuggestions([])
      return
    }
    searchTimer = setTimeout(() => {
      const seq = ++searchSeq
      void suggestInstitutions(q).then((rows) => {
        if (seq === searchSeq) setSuggestions(rows)
      })
    }, 200)
  }
  const pick = async (sug: InstitutionSuggestion) => {
    setFields({ ...fields(), affiliation: sug.name, affiliation_logo: institutionLogoUrl(sug.domain) })
    setSuggestions([])
    setResolvingLogo((n) => n + 1)
    try {
      const logo = await resolveBrandLogo(sug.name, sug.domain)
      if (logo && fields().affiliation === sug.name) setFields({ ...fields(), affiliation_logo: logo })
    } finally {
      setResolvingLogo((n) => Math.max(0, n - 1))
    }
  }

  const saveAndPreview = async () => {
    setSaving(true)
    setSaveError(undefined)
    try {
      await props.onComplete(fields())
      setStep(props.onUploadPaper ? 2 : FINAL)
    } catch {
      setSaveError("Couldn't save — server unreachable. Try again.")
    } finally {
      setSaving(false)
    }
  }

  const Dots = () => (
    <div style={{ display: "flex", gap: "6px", "justify-content": "center" }}>
      <For each={props.onUploadPaper ? [0, 1, 2, 3] : [0, 1, 3]}>
        {(i) => (
          <span
            style={{
              width: "6px",
              height: "6px",
              "border-radius": "var(--radius-full)",
              background: step() === i ? "var(--v2-icon-icon-accent)" : "var(--v2-border-border-base)",
            }}
          />
        )}
      </For>
    </div>
  )

  const PrimaryBtn = (p: { label: string; onClick: () => void; disabled?: boolean }) => (
    <button
      type="button"
      disabled={p.disabled}
      onClick={() => p.onClick()}
      style={{
        background: "var(--accent, #fff676)",
        color: "var(--accent-ink, #111214)",
        border: "none",
        "border-radius": "var(--radius-lg)",
        padding: "10px 22px",
        "font-size": "14px",
        "font-weight": "650",
        cursor: p.disabled ? "wait" : "pointer",
        "box-shadow": "0 2px 10px color-mix(in srgb, var(--v2-icon-icon-accent) 35%, transparent)",
        opacity: p.disabled ? "0.7" : "1",
      }}
    >
      {p.label}
    </button>
  )
  const QuietBtn = (p: { label: string; onClick: () => void }) => (
    <button
      type="button"
      onClick={() => p.onClick()}
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        color: "var(--v2-text-text-muted)",
        "font-size": "12px",
        padding: "8px 4px",
      }}
    >
      {p.label}
    </button>
  )

  return (
    <div
      data-component="amicode-onboarding-wizard"
      style={{
        position: "fixed",
        inset: "0",
        "z-index": "70",
        background: "color-mix(in srgb, #000 55%, transparent)",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
      }}
    >
      <div
        style={{
          width: "min(560px, calc(100vw - 48px))",
          "max-height": "min(640px, calc(100vh - 48px))",
          "overflow-y": "auto",
          "border-radius": "var(--radius-xl)",
          border: "1px solid var(--v2-border-border-base)",
          background: "var(--v2-background-bg-base)",
          padding: "28px 32px 22px",
          display: "flex",
          "flex-direction": "column",
          gap: "18px",
        }}
      >
        {/* step 0 — welcome */}
        <Show when={step() === 0}>
          <div
            style={{
              display: "flex",
              "flex-direction": "column",
              "align-items": "center",
              gap: "14px",
              "text-align": "center",
              padding: "14px 0 4px",
            }}
          >
            <MarkDetailed class="w-14 h-auto" />
            <div>
              <div style={{ "font-size": "22px", "font-weight": "700", color: "var(--v2-text-text-base)" }}>
                Welcome to Amicode
              </div>
              <div
                style={{
                  "font-size": "13px",
                  "line-height": "19px",
                  color: "var(--v2-text-text-muted)",
                  "margin-top": "6px",
                  "max-width": "380px",
                }}
              >
                Amico is your research and coding companion — it runs experiments from a conversation, remembers your
                results, and adapts to your workflow. Thirty seconds of setup makes it yours.
              </div>
            </div>
            <div
              style={{
                display: "flex",
                "flex-direction": "column",
                "align-items": "center",
                gap: "4px",
                "margin-top": "6px",
              }}
            >
              <PrimaryBtn label="Set up my workspace" onClick={() => setStep(1)} />
              <QuietBtn label="Skip for now" onClick={() => props.onDismiss()} />
            </div>
          </div>
        </Show>

        {/* step 1 — about you */}
        <Show when={step() === 1}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
            <div>
              <div style={{ "font-size": "17px", "font-weight": "700", color: "var(--v2-text-text-base)" }}>
                About you
              </div>
              <div style={{ "font-size": "12px", color: "var(--v2-text-text-muted)", "margin-top": "2px" }}>
                This fills your home page and helps Amico tailor its physics to you.
              </div>
            </div>
            <div>
              <div style={LABEL}>Name</div>
              <input
                class="amc-input"
                value={fields().name}
                onInput={(e) => setFields({ ...fields(), name: e.currentTarget.value })}
                placeholder="Ada Lovelace"
              />
            </div>
            <div style={{ position: "relative" }}>
              <div style={LABEL}>Institution</div>
              <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                <Show when={fields().affiliation_logo}>
                  <img
                    src={fields().affiliation_logo}
                    alt=""
                    style={{
                      width: "26px",
                      height: "26px",
                      "object-fit": "contain",
                      "border-radius": "var(--radius-sm)",
                      flex: "none",
                      background: "#FFF",
                      padding: "2px",
                    }}
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                </Show>
                <input
                  class="amc-input"
                  value={fields().affiliation}
                  onInput={(e) => {
                    setFields({ ...fields(), affiliation: e.currentTarget.value })
                    search(e.currentTarget.value)
                  }}
                  placeholder="Start typing — we'll find the logo"
                />
              </div>
              <Show when={suggestions().length > 0}>
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: "0",
                    right: "0",
                    "z-index": "5",
                    background: "var(--v2-background-bg-layer-01)",
                    border: "1px solid var(--v2-border-border-base)",
                    "border-radius": "var(--radius-md)",
                    "margin-top": "4px",
                    overflow: "hidden",
                  }}
                >
                  <For each={suggestions()}>
                    {(sug) => (
                      <button
                        type="button"
                        onClick={() => void pick(sug)}
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                          width: "100%",
                          padding: "7px 10px",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--v2-text-text-base)",
                          "font-size": "13px",
                          "text-align": "left",
                        }}
                      >
                        <img
                          src={institutionLogoUrl(sug.domain)}
                          alt=""
                          style={{
                            width: "18px",
                            height: "18px",
                            "object-fit": "contain",
                            "border-radius": "var(--radius-sm)",
                            flex: "none",
                          }}
                          onError={(e) => (e.currentTarget.style.display = "none")}
                        />
                        <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                          {sug.name}
                        </span>
                        <span
                          style={{ "margin-left": "auto", "font-size": "11px", color: "var(--v2-text-text-faint)" }}
                        >
                          {sug.domain}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <div>
              <div style={LABEL}>Research area</div>
              <input
                class="amc-input"
                value={fields().focus}
                onInput={(e) => setFields({ ...fields(), focus: e.currentTarget.value })}
                placeholder="e.g. optimal control, ML research, materials science"
              />
            </div>
            <div>
              <div style={LABEL}>Google Scholar (optional)</div>
              <input
                class="amc-input"
                value={fields().scholar}
                onInput={(e) => setFields({ ...fields(), scholar: e.currentTarget.value })}
                placeholder="https://scholar.google.com/…"
              />
            </div>
            <Show when={saveError()}>
              <div style={{ "font-size": "12px", color: "var(--v2-state-fg-danger)" }}>{saveError()}</div>
            </Show>
            <div style={{ display: "flex", "align-items": "center", gap: "10px", "margin-top": "4px" }}>
              <PrimaryBtn
                label={saving() ? "Saving…" : resolvingLogo() > 0 ? "Finding logo…" : "Continue"}
                disabled={saving() || resolvingLogo() > 0}
                onClick={() => void saveAndPreview()}
              />
              <QuietBtn label="Back" onClick={() => setStep(0)} />
              <span style={{ "margin-left": "auto" }}>
                <QuietBtn label="Skip" onClick={() => props.onDismiss()} />
              </span>
            </div>
          </div>
        </Show>

        {/* step 2 — library: papers that make Amico smarter (optional) */}
        <Show when={step() === 2 && props.onUploadPaper}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
            <div>
              <div style={{ "font-size": "17px", "font-weight": "700", color: "var(--v2-text-text-base)" }}>
                Teach Amico your work
              </div>
              <div style={{ "font-size": "12px", color: "var(--v2-text-text-muted)", "margin-top": "2px" }}>
                Upload papers (PDFs) — Amico reads them to learn your methods and results. You can add more anytime from
                the Library card on the home page.
              </div>
            </div>
            <input
              ref={paperInput}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              style={{ display: "none" }}
              onChange={(e) => void uploadPapers(e.currentTarget.files)}
            />
            <Show when={uploaded().length > 0}>
              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <For each={uploaded()}>
                  {(name) => (
                    <div
                      style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "6px",
                        "font-size": "12px",
                        color: "var(--v2-text-text-base)",
                      }}
                    >
                      <span style={{ color: "var(--v2-state-fg-success)" }}>✓</span>
                      <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                        {name}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={uploadError()}>
              <div style={{ "font-size": "12px", color: "var(--v2-state-fg-danger)" }}>{uploadError()}</div>
            </Show>
            <div style={{ display: "flex", "align-items": "center", gap: "10px", "margin-top": "4px" }}>
              <PrimaryBtn
                label={uploadBusy() ? "Uploading…" : uploaded().length > 0 ? "Add another PDF" : "Upload a PDF"}
                disabled={uploadBusy()}
                onClick={() => paperInput?.click()}
              />
              <PrimaryBtn
                label={uploaded().length > 0 ? "Continue" : "Continue without papers"}
                disabled={uploadBusy()}
                onClick={() => setStep(FINAL)}
              />
              <span style={{ "margin-left": "auto" }}>
                <QuietBtn label="Back" onClick={() => setStep(1)} />
              </span>
            </div>
          </div>
        </Show>

        {/* final step — done: the profile as the home page will show it */}
        <Show when={step() === FINAL}>
          <div
            style={{
              display: "flex",
              "flex-direction": "column",
              "align-items": "center",
              gap: "14px",
              "text-align": "center",
              padding: "10px 0 4px",
            }}
          >
            <div
              style={{
                display: "flex",
                "align-items": "center",
                gap: "12px",
                padding: "12px 16px",
                "border-radius": "var(--radius-lg)",
                background: "var(--accent-fill-soft)",
                border: "1px solid var(--accent-edge)",
              }}
            >
              <Show when={fields().affiliation_logo} fallback={<Mark class="w-9 h-auto" />}>
                <span
                  style={{
                    display: "inline-flex",
                    "align-items": "center",
                    "justify-content": "center",
                    width: "40px",
                    height: "40px",
                    "border-radius": "var(--radius-md)",
                    background: "#FFF",
                    padding: "4px",
                  }}
                >
                  <img
                    src={fields().affiliation_logo}
                    alt=""
                    style={{ width: "100%", height: "100%", "object-fit": "contain" }}
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                </span>
              </Show>
              <div style={{ "text-align": "left" }}>
                <div style={{ "font-size": "14px", "font-weight": "650", color: "var(--v2-text-text-base)" }}>
                  {fields().name || "You"}
                </div>
                <div style={{ "font-size": "12px", color: "var(--v2-text-text-muted)" }}>
                  {fields().affiliation || "Independent"}
                </div>
              </div>
            </div>
            <div style={{ "font-size": "13px", color: "var(--v2-text-text-muted)", "max-width": "360px" }}>
              You're set — a personal vault is ready. Amico will remember your context across sessions.
            </div>
            {/* attach-your-own-vault: quiet by default so it never crowds the payoff shot */}
            <Show when={props.onAttachVault}>
              <div style={{ width: "min(360px, 100%)" }}>
                <Show when={!attachOpen()}>
                  <QuietBtn label="Already have a vault? Attach it →" onClick={() => setAttachOpen(true)} />
                </Show>
                <Show when={attachOpen()}>
                  <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "text-align": "left" }}>
                    <div style={LABEL}>Attach a vault</div>
                    <div style={{ display: "flex", gap: "6px", "align-items": "stretch" }}>
                      <input
                        class="amc-input"
                        value={attachRef()}
                        onInput={(e) => setAttachRef(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void attach()
                        }}
                        placeholder="owner/repo, a git URL, or a local path"
                      />
                      <PrimaryBtn label={attaching() ? "…" : "Attach"} disabled={attaching()} onClick={() => void attach()} />
                    </div>
                    <div style={{ "font-size": "11px", color: "var(--v2-text-text-faint)" }}>
                      A GitHub repo you can access, or a folder with an <code>.amico-vault.toml</code> marker.
                    </div>
                    <For each={attached()}>
                      {(name) => (
                        <div style={{ display: "flex", "align-items": "center", gap: "6px", "font-size": "12px" }}>
                          <span style={{ color: "var(--v2-state-fg-success)" }}>✓</span>
                          <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                            {name}
                          </span>
                        </div>
                      )}
                    </For>
                    <Show when={attachError()}>
                      <div style={{ "font-size": "12px", color: "var(--v2-state-fg-danger)" }}>{attachError()}</div>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
            <div style={{ display: "flex", "flex-direction": "column", "align-items": "center", gap: "4px" }}>
              <PrimaryBtn label="Go to my home page" onClick={() => props.onDismiss()} />
              <QuietBtn label="or start a chat with Amico" onClick={() => props.onOpenChat()} />
            </div>
          </div>
        </Show>

        <Dots />
      </div>
    </div>
  )
}
