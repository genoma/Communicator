import { search } from "@inquirer/prompts"

export async function selectSession(sessions) {
  const choices = sessions.map((s) => {
    const time = s.id.replace("T", " ")
    const model = s.model.length > 35 ? s.model.slice(0, 32) + "..." : s.model
    const count = `${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}`
    const preview = s.preview ? `"${s.preview}${s.preview.length >= 60 ? "..." : ""}"` : ""

    return {
      name: `${time}  ${model.padEnd(37)} ${count.padEnd(12)} ${preview}`,
      value: s.id,
      description: `${s.providerName}  •  ${s.messageCount} messages`,
    }
  })

  const answer = await search({
    message: "Select a session to resume",
    source: async (input) => {
      if (!input) return choices
      const q = input.toLowerCase()
      return choices.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.value.toLowerCase().includes(q) ||
          (c.description && c.description.toLowerCase().includes(q))
      )
    },
  })

  return answer
}
