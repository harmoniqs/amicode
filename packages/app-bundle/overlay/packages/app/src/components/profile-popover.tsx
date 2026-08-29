import { batch, createEffect, createSignal, Show, type ComponentProps, type JSX } from "solid-js"
import { Popover } from "@opencode-ai/ui/popover"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { announceChromeDropdown, chromeDropdownOpenId, clearChromeDropdown } from "@/utils/chrome-dropdown"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { amicodeGet, amicodePost } from "@/utils/amicode-fetch"

interface ProfileData {
  name: string
  role: string | null
  affiliation: string | null
  affiliation_logo: string | null
  focus: string | null
  description: string | null
  avatar: string | null
  github: string | null
  scholar: string | null
  custom_link: { url: string; label: string } | null
}

export function ProfilePopoverTrigger() {
  const [shown, setShownRaw] = createSignal(false)
  const [profile, setProfile] = createSignal<ProfileData | null>(null)
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal({
    name: "",
    role: "",
    affiliation: "",
    focus: "",
    description: "",
    scholar: "",
    github: "",
    custom_link_url: "",
    custom_link_label: "",
  })
  const server = useServer()
  const platform = usePlatform()

  const setShown = (next: boolean) => {
    batch(() => {
      if (next) announceChromeDropdown("profile")
      else clearChromeDropdown("profile")
      setShownRaw(next)
    })
  }

  createEffect(() => {
    if (chromeDropdownOpenId() !== "profile" && shown()) setShownRaw(false)
  })

  const fetchProfile = async () => {
    try {
      const data = await amicodeGet(server.current, "/amicode/profile") as any
      if (data.ok && data.you) setProfile(data.you)
    } catch {
      /* silent */
    }
  }

  createEffect(() => {
    if (shown()) void fetchProfile()
  })

  const beginEdit = () => {
    const p = profile()
    setDraft({
      name: p?.name ?? "",
      role: p?.role ?? "",
      affiliation: p?.affiliation ?? "",
      focus: p?.focus ?? "",
      description: p?.description ?? "",
      scholar: p?.scholar ?? "",
      github: p?.github ?? "",
      custom_link_url: p?.custom_link?.url ?? "",
      custom_link_label: p?.custom_link?.label ?? "",
    })
    setEditing(true)
  }

  const save = async () => {
    const d = draft()
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(d)) params.set(k, v)
    try {
      const data = await amicodePost(server.current, `/amicode/profile?${params.toString()}`) as any
      if (data.ok && data.you) setProfile(data.you)
      setEditing(false)
    } catch {
      /* silent */
    }
  }

  const initials = () => {
    const p = profile()
    if (!p?.name) return ""
    const parts = p.name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return parts[0][0]?.toUpperCase() ?? ""
  }

  const isEmpty = () => {
    const p = profile()
    if (!p) return true
    // Show edit mode only when there's truly nothing set (no name beyond default, no role, no affiliation)
    return (!p.name || p.name === "Practitioner") && !p.role && !p.affiliation && !p.focus
  }

  const openExternal = (url: string) => {
    platform.openExternal(url)
  }

  const saveAvatar = async (dataUrl: string) => {
    // Resize to 96x96 to keep profile.json small
    const resized = await resizeImage(dataUrl, 96)
    try {
      const data = await amicodePost(server.current, "/amicode/profile", { avatar: resized }) as any
      if (data.ok && data.you) setProfile(data.you)
    } catch {
      /* silent */
    }
  }

  const removeAvatar = async () => {
    try {
      const data = await amicodePost(server.current, "/amicode/profile", { avatar: "" }) as any
      if (data.ok && data.you) setProfile(data.you)
    } catch {
      /* silent */
    }
  }

  return (
    <Popover
      open={shown()}
      onOpenChange={setShown}
      triggerAs="button"
      triggerProps={
        {
          type: "button",
          "aria-label": "Profile",
          "data-component": "icon-button-v2",
          "data-variant": "ghost-muted",
          "data-size": "large",
          class: "!w-9 shrink-0",
          style: { border: "none" },
        } as ComponentProps<"button">
      }
      trigger={<IconV2 name="person" />}
      class="[&_[data-slot=popover-body]]:p-0 w-[320px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-lg"
      gutter={8}
      placement="bottom-start"
    >
      <Show when={shown()}>
        <div
          style={{
            background: "var(--v2-background-bg-base)",
            border: "1px solid var(--v2-border-border-base)",
            "border-radius": "10px",
            padding: "16px",
            "box-shadow": "var(--shadow-lg-border-base)",
          }}
        >
          <Show
            when={!editing() && !isEmpty()}
            fallback={<EditForm draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setEditing(false)} onAvatarChange={saveAvatar} onAvatarRemove={removeAvatar} currentAvatar={profile()?.avatar ?? null} isEmpty={isEmpty()} />}
          >
            <ReadView profile={profile()!} initials={initials()} onEdit={beginEdit} onOpenExternal={openExternal} />
          </Show>
        </div>
      </Show>
    </Popover>
  )
}

function ReadView(props: {
  profile: ProfileData
  initials: string
  onEdit: () => void
  onOpenExternal: (url: string) => void
}) {
  const [logoBroken, setLogoBroken] = createSignal(false)
  const [bioExpanded, setBioExpanded] = createSignal(false)

  return (
    <div>
      {/* Header: avatar + name/role/affiliation */}
      <div style={{ display: "flex", gap: "12px", "align-items": "flex-start" }}>
        {/* Avatar */}
        <div
          style={{
            width: "48px",
            height: "48px",
            "border-radius": "10px",
            "flex-shrink": "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            overflow: "hidden",
            background: props.profile.avatar ? "transparent" : "var(--accent, #fff676)",
            color: "var(--accent-ink, #111214)",
            "font-size": "16px",
            "font-weight": "700",
          }}
        >
          <Show when={props.profile.avatar} fallback={
            <Show when={props.initials} fallback={<IconV2 name="person" />}>
              {props.initials}
            </Show>
          }>
            <img
              src={props.profile.avatar!}
              style={{ width: "100%", height: "100%", "object-fit": "cover", "border-radius": "10px" }}
              alt="Profile"
            />
          </Show>
        </div>
        {/* Name + Role + Affiliation */}
        <div style={{ flex: "1", "min-width": "0" }}>
          <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
            <div
              style={{
                "font-size": "15px",
                "font-weight": "600",
                color: "var(--v2-text-text-base)",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              {props.profile.name}
            </div>
            <button
              type="button"
              onClick={props.onEdit}
              title="Edit profile"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--v2-text-text-faint)",
                "font-size": "12px",
                padding: "2px",
                "line-height": "1",
              }}
            >
              ✎
            </button>
          </div>
          <Show when={props.profile.role || props.profile.affiliation}>
            <div style={{ "font-size": "12px", color: "var(--v2-text-text-muted)", "margin-top": "1px" }}>
              {props.profile.role && props.profile.affiliation
                ? `${props.profile.role} @ ${props.profile.affiliation}`
                : props.profile.role || props.profile.affiliation}
            </div>
          </Show>
        </div>
      </div>

      {/* Focus + Description */}
      <Show when={props.profile.focus || props.profile.description}>
        <div style={{ "margin-top": "12px" }}>
          <Show when={props.profile.focus}>
            <div style={{ "font-size": "12px", color: "var(--v2-text-text-base)", "font-weight": "500" }}>
              {props.profile.focus}
            </div>
          </Show>
          <Show when={props.profile.description}>
            <div
              onClick={() => setBioExpanded(!bioExpanded())}
              style={{
                "font-size": "12px",
                color: "var(--v2-text-text-muted)",
                "margin-top": "4px",
                cursor: "pointer",
              }}
            >
              <div
                style={bioExpanded() ? {} : {
                  display: "-webkit-box",
                  "-webkit-line-clamp": "2",
                  "-webkit-box-orient": "vertical",
                  overflow: "hidden",
                }}
              >
                {props.profile.description}
              </div>
            </div>
          </Show>
        </div>
      </Show>

      {/* Link pills */}
      <div style={{ display: "flex", gap: "8px", "margin-top": "12px" }}>
        <LinkPill
          icon={<ScholarIcon />}
          url={props.profile.scholar}
          tooltip="Google Scholar"
          onOpen={props.onOpenExternal}
        />
        <LinkPill
          icon={<GitHubIcon />}
          url={props.profile.github}
          tooltip="GitHub"
          onOpen={props.onOpenExternal}
        />
        <LinkPill
          icon={<LinkIcon />}
          url={props.profile.custom_link?.url ?? null}
          tooltip={props.profile.custom_link?.label || "Custom link"}
          onOpen={props.onOpenExternal}
        />
      </div>
    </div>
  )
}

function LinkPill(props: { icon: JSX.Element; url: string | null; tooltip: string; onOpen: (url: string) => void }) {
  const filled = () => !!props.url
  return (
    <button
      type="button"
      title={props.tooltip}
      disabled={!filled()}
      onClick={() => filled() && props.onOpen(props.url!)}
      style={{
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        width: "28px",
        height: "28px",
        "border-radius": "6px",
        border: "1px solid var(--v2-border-border-base)",
        background: "var(--v2-background-bg-layer-01)",
        cursor: filled() ? "pointer" : "default",
        opacity: filled() ? "1" : "0.35",
        "font-size": "12px",
        color: "var(--v2-text-text-muted)",
        padding: "0",
      }}
    >
      {props.icon}
    </button>
  )
}

function EditForm(props: {
  draft: () => Record<string, string>
  setDraft: (d: Record<string, string>) => void
  onSave: () => void
  onCancel: () => void
  onAvatarChange: (dataUrl: string) => void
  onAvatarRemove: () => void
  currentAvatar: string | null
  isEmpty: boolean
}) {
  const update = (key: string, value: string) => props.setDraft({ ...props.draft(), [key]: value })
  let fileInput: HTMLInputElement | undefined

  const handleFileSelect = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    if (!file.type.startsWith("image/")) return
    const reader = new FileReader()
    reader.onload = () => {
      props.onAvatarChange(reader.result as string)
    }
    reader.readAsDataURL(file)
    input.value = ""
  }

  const avatarInitials = () => {
    const name = props.draft().name
    if (!name) return ""
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return parts[0][0]?.toUpperCase() ?? ""
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
      {/* Hidden file input */}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFileSelect}
      />
      {/* Clickable avatar tile */}
      <div style={{ position: "relative", "align-self": "center", width: "48px", height: "48px" }}>
        <div
          onClick={() => fileInput?.click()}
          title="Click to change photo"
          style={{
            width: "48px",
            height: "48px",
            "border-radius": "10px",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            overflow: "hidden",
            background: props.currentAvatar ? "transparent" : "var(--accent, #fff676)",
            color: "var(--accent-ink, #111214)",
            "font-size": "16px",
            "font-weight": "700",
            cursor: "pointer",
            border: "1px dashed var(--v2-border-border-base)",
          }}
        >
          <Show when={props.currentAvatar} fallback={
            <Show when={avatarInitials()} fallback={<IconV2 name="person" />}>
              {avatarInitials()}
            </Show>
          }>
            <img
              src={props.currentAvatar!}
              style={{ width: "100%", height: "100%", "object-fit": "cover", "border-radius": "10px" }}
              alt="Profile"
            />
          </Show>
        </div>
        <Show when={props.currentAvatar}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); props.onAvatarRemove() }}
            title="Remove photo"
            style={{
              position: "absolute",
              top: "-4px",
              right: "-4px",
              width: "16px",
              height: "16px",
              "border-radius": "50%",
              border: "1px solid var(--v2-border-border-base)",
              background: "var(--v2-background-bg-base)",
              color: "var(--v2-text-text-muted)",
              "font-size": "10px",
              "line-height": "1",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              cursor: "pointer",
              padding: "0",
            }}
          >
            ✕
          </button>
        </Show>
      </div>
      <input
        class="amc-input amc-input--compact"
        placeholder="Your name"
        value={props.draft().name}
        onInput={(e) => update("name", e.currentTarget.value)}
        autofocus={props.isEmpty}
        style={{ "font-size": "14px", "font-weight": "600" }}
      />
      <input
        class="amc-input amc-input--compact"
        placeholder="Role (e.g. Postdoc, PhD Student)"
        value={props.draft().role}
        onInput={(e) => update("role", e.currentTarget.value)}
      />
      <input
        class="amc-input amc-input--compact"
        placeholder="Affiliation"
        value={props.draft().affiliation}
        onInput={(e) => update("affiliation", e.currentTarget.value)}
      />
      <input
        class="amc-input amc-input--compact"
        placeholder="Research area"
        value={props.draft().focus}
        onInput={(e) => update("focus", e.currentTarget.value)}
      />
      <textarea
        class="amc-input amc-input--compact"
        placeholder="Short bio"
        value={props.draft().description}
        onInput={(e) => update("description", e.currentTarget.value)}
        rows={4}
        style={{ resize: "vertical", "min-height": "60px" }}
      />
      <div style={{ display: "flex", gap: "6px", "margin-top": "4px" }}>
        <input
          class="amc-input amc-input--compact"
          placeholder="Scholar URL"
          value={props.draft().scholar}
          onInput={(e) => update("scholar", e.currentTarget.value)}
          style={{ flex: "1" }}
        />
        <input
          class="amc-input amc-input--compact"
          placeholder="GitHub URL"
          value={props.draft().github}
          onInput={(e) => update("github", e.currentTarget.value)}
          style={{ flex: "1" }}
        />
      </div>
      <div style={{ display: "flex", gap: "6px" }}>
        <input
          class="amc-input amc-input--compact"
          placeholder="Custom link URL"
          value={props.draft().custom_link_url}
          onInput={(e) => update("custom_link_url", e.currentTarget.value)}
          style={{ flex: "1" }}
        />
        <input
          class="amc-input amc-input--compact"
          placeholder="Label"
          value={props.draft().custom_link_label}
          onInput={(e) => update("custom_link_label", e.currentTarget.value)}
          style={{ width: "80px" }}
        />
      </div>
      <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end", "margin-top": "4px" }}>
        <Show when={!props.isEmpty}>
          <button
            type="button"
            onClick={props.onCancel}
            style={{
              background: "none",
              border: "1px solid var(--v2-border-border-base)",
              "border-radius": "6px",
              padding: "4px 12px",
              "font-size": "12px",
              color: "var(--v2-text-text-muted)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </Show>
        <button
          type="button"
          onClick={props.onSave}
          style={{
            background: "var(--accent, #fff676)",
            color: "var(--accent-ink, #111214)",
            border: "none",
            "border-radius": "6px",
            padding: "4px 12px",
            "font-size": "12px",
            "font-weight": "600",
            cursor: "pointer",
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}

function resizeImage(dataUrl: string, size: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext("2d")!
      // Center-crop: use the smaller dimension as the source square
      const src = Math.min(img.width, img.height)
      const sx = (img.width - src) / 2
      const sy = (img.height - src) / 2
      ctx.drawImage(img, sx, sy, src, src, 0, 0, size, size)
      resolve(canvas.toDataURL("image/png"))
    }
    img.onerror = () => resolve(dataUrl) // fallback: send as-is
    img.src = dataUrl
  })
}

function GitHubIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
      <path d="M10.0001 1.62549C14.6042 1.62549 18.3334 5.35465 18.3334 9.95882C18.333 11.7049 17.785 13.4068 16.7666 14.8251C15.7482 16.2434 14.3107 17.3066 12.6563 17.8651C12.2397 17.9484 12.0834 17.688 12.0834 17.4692C12.0834 17.188 12.0938 16.2922 12.0938 15.1776C12.0938 14.3963 11.8334 13.8963 11.5313 13.6359C13.3855 13.4276 15.3334 12.7192 15.3334 9.52132C15.3334 8.60465 15.0105 7.86507 14.4792 7.28174C14.5626 7.0734 14.8542 6.21924 14.3959 5.0734C14.3959 5.0734 13.698 4.84424 12.1042 5.92757C11.4376 5.74007 10.7292 5.64632 10.0209 5.64632C9.31258 5.64632 8.60425 5.74007 7.93758 5.92757C6.34383 4.85465 5.64592 5.0734 5.64592 5.0734C5.18758 6.21924 5.47925 7.0734 5.56258 7.28174C5.03133 7.86507 4.70842 8.61507 4.70842 9.52132C4.70842 12.7088 6.64592 13.4276 8.50008 13.6359C8.2605 13.8442 8.04175 14.2088 7.96883 14.7505C7.48967 14.9692 6.29175 15.3234 5.54175 14.063C5.3855 13.813 4.91675 13.1984 4.2605 13.2088C3.56258 13.2192 3.97925 13.6047 4.27092 13.7609C4.62508 13.9588 5.03133 14.6984 5.12508 14.938C5.29175 15.4067 5.83342 16.3026 7.92717 15.9172C7.92717 16.6151 7.93758 17.2713 7.93758 17.4692C7.93758 17.688 7.78133 17.938 7.36467 17.8651C5.70491 17.3126 4.26126 16.2515 3.23851 14.8324C2.21576 13.4133 1.66583 11.7081 1.66675 9.95882C1.66675 5.35465 5.39592 1.62549 10.0001 1.62549Z" fill="currentColor"/>
    </svg>
  )
}

function ScholarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 1L1 5L8 9L15 5L8 1Z" stroke="currentColor" stroke-linejoin="round"/>
      <path d="M3 6.5V11.5C3 11.5 5 13.5 8 13.5C11 13.5 13 11.5 13 11.5V6.5" stroke="currentColor" stroke-linejoin="round"/>
      <path d="M15 5V11" stroke="currentColor" stroke-linecap="round"/>
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M6.5 9.5L9.5 6.5" stroke="currentColor" stroke-linecap="round"/>
      <path d="M7.5 11.5L6 13C4.89543 14.1046 3.10457 14.1046 2 13C0.89543 11.8954 0.89543 10.1046 2 9L3.5 7.5" stroke="currentColor" stroke-linecap="round"/>
      <path d="M8.5 4.5L10 3C11.1046 1.89543 12.8954 1.89543 14 3C15.1046 4.10457 15.1046 5.89543 14 7L12.5 8.5" stroke="currentColor" stroke-linecap="round"/>
    </svg>
  )
}
