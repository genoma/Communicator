import { search } from "@inquirer/prompts"
import { formatSessionItem } from "./sessions.js"

export async function selectSession(sessions) {
  const choices = sessions.map((s) => {
    const { line } = formatSessionItem(s)

    return {
      name: line,
      value: s.id,
      description: `${s.providerName}  \u2022  ${s.messageCount} messages`,
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
