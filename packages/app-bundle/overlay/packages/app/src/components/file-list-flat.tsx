import { For, Show, createMemo, createSignal, type Accessor } from "solid-js"
import { Popover } from "@opencode-ai/ui/popover"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import FileTree from "@/components/file-tree"
import { disambiguateFilenames, getCommonAncestor, sortPathsByFilename } from "@/components/file-list-model"

export interface FileListFlatProps {
  files: Accessor<string[]>
  kinds: Accessor<Map<string, "add" | "del" | "mix">>
  active?: string
  onFileClick: (path: string) => void
}

export function FileListFlat(props: FileListFlatProps) {
  const [popoverOpen, setPopoverOpen] = createSignal(false)
  const [clickedFile, setClickedFile] = createSignal<string | undefined>()

  const sorted = createMemo(() => sortPathsByFilename(props.files()))
  const items = createMemo(() => disambiguateFilenames(sorted()))
  const commonAncestor = createMemo(() => getCommonAncestor(props.files()))

  const handleFileClick = (path: string) => {
    setClickedFile(path)
    setPopoverOpen(true)
  }

  const handleTreeFileClick = (path: string) => {
    setPopoverOpen(false)
    props.onFileClick(path)
  }

  return (
    <div class="pt-3 flex flex-col gap-0.5" data-component="file-list-flat">
      <For each={items()}>
        {(item) => {
          const kind = () => props.kinds().get(item.path)
          const isActive = () => props.active === item.path

          return (
            <TooltipV2 value={item.path} placement="left">
              <Popover
                open={popoverOpen() && clickedFile() === item.path}
                onOpenChange={(open) => {
                  if (!open) setPopoverOpen(false)
                }}
                placement="bottom-start"
                trigger={
                  <div
                    class="w-full flex items-center gap-1.5 px-2 py-1 rounded text-left text-12-regular cursor-pointer transition-colors hover:bg-background-base"
                    classList={{
                      "bg-background-base text-text-base": isActive(),
                      "text-text-weak": !isActive(),
                    }}
                    onClick={() => handleFileClick(item.path)}
                    data-file-path={item.path}
                    data-testid="file-list-flat-item"
                  >
                    <span
                      class="w-1.5 h-1.5 rounded-full shrink-0"
                      classList={{
                        "bg-green-500": kind() === "add",
                        "bg-yellow-500": kind() === "mix",
                        "bg-red-500": kind() === "del",
                      }}
                    />
                    <span class="truncate">{item.label}</span>
                    <Show when={item.disambiguator}>
                      <span class="text-text-faint text-11-regular shrink-0">
                        ({item.disambiguator})
                      </span>
                    </Show>
                  </div>
                }
                class="p-2 max-h-[300px] overflow-auto min-w-[200px]"
              >
                <Show when={commonAncestor()}>
                  <div class="text-11-regular text-text-faint px-2 pb-1 truncate">
                    {commonAncestor()}/
                  </div>
                </Show>
                <FileTree
                  path=""
                  allowed={props.files()}
                  kinds={props.kinds()}
                  draggable={false}
                  active={clickedFile()}
                  onFileClick={(node) => handleTreeFileClick(node.path)}
                />
              </Popover>
            </TooltipV2>
          )
        }}
      </For>
    </div>
  )
}
