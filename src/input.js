import { join } from "node:path"
import { homedir } from "node:os"
import { readMultiline } from "@toiroakr/read-multiline"

const HISTORY_PATH = join(homedir(), ".communicator", "history.json")

export async function readInput() {
  const [value, error] = await readMultiline("", {
    prefix: "> ",
    helpFooter: true,
    maxLines: 50,
    history: {
      filePath: HISTORY_PATH,
      maxEntries: 200,
      shouldPersist: (v) => v.trim() !== "",
    },
    theme: {
      submitRender: "preserve",
    },
  })

  if (error) {
    if (error.kind === "cancel") return { cancelled: true, partial: value }
    if (error.kind === "eof") return { cancelled: true, eof: true }
    return { cancelled: true }
  }

  return { value }
}
