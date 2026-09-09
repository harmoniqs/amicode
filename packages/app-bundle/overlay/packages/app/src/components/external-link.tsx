import { ComponentProps, splitProps } from "solid-js"
import { usePlatform } from "@/context/platform"

export interface ExternalLinkProps extends Omit<ComponentProps<"a">, "href"> {
  href: string
}

export function ExternalLink(props: ExternalLinkProps) {
  const platform = usePlatform()
  const [local, rest] = splitProps(props, ["href", "children", "class", "target", "rel", "onClick"])

  return (
    <a
      href={local.href}
      class={`text-text-strong underline ${local.class ?? ""}`}
      target={local.target ?? "_blank"}
      rel={local.rel ?? "noopener noreferrer"}
      onClick={(event) => {
        if (typeof local.onClick === "function") local.onClick(event)
        if (Array.isArray(local.onClick)) local.onClick[0](local.onClick[1], event)
        if (event.defaultPrevented) return
        event.preventDefault()
        platform.openExternal(local.href)
      }}
      {...rest}
    >
      {local.children}
    </a>
  )
}
