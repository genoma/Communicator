import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CliError } from './errors.js'
import { writeFileAtomic } from './fs-utils.js'

export const RPG_FILES = ['char.md', 'user.md', 'prompt.md', 'scenario.md', 'first-message.md']
export const RPG_TEMPLATE_MARKER = 'RPG_TEMPLATE'
export const RPG_FIRST_MESSAGE_PLACEHOLDER = 'RPG_FIRST_MESSAGE_TODO'
export const RPG_HISTORY_FILE = 'history.json'

const CARD_TEMPLATE = `<!-- RPG_TEMPLATE: delete this comment after filling in this file.
     Fill every section below (rename, remove, or add sections as needed). -->

# Name

## Description

## Personality

## Appearance

## Background

## Speech and example lines
`

const PROMPT_TEMPLATE = `<!-- RPG_TEMPLATE: delete this comment after filling in this file.
     Fill every section below (rename, remove, or add sections as needed). -->

## Setting and genre

## Tone

## Narrative style

## Rules
-
`

const SCENARIO_TEMPLATE = `<!-- RPG_TEMPLATE: delete this comment after filling in this file.
     Fill every section below (rename, remove, or add sections as needed). -->

## Current scene

## Time and place

## Immediate situation
`

const FIRST_MESSAGE_TEMPLATE = `<!-- RPG_TEMPLATE: delete this comment after filling in this file.
     Replace the line below with the opening message; you can write multiple paragraphs. -->

RPG_FIRST_MESSAGE_TODO: Write the opening message from {{char}} here.
`

const TEMPLATES = {
  'char.md': CARD_TEMPLATE,
  'user.md': CARD_TEMPLATE,
  'prompt.md': PROMPT_TEMPLATE,
  'scenario.md': SCENARIO_TEMPLATE,
  'first-message.md': FIRST_MESSAGE_TEMPLATE,
}

function fileError(file, message) {
  return new CliError(`Error: ${file} ${message}`)
}

function stripMarkdownComments(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, '').trim()
}

export function parseRpgName(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+?)\s*$/m)
  return match?.[1].trim() || fallback
}

function headingName(markdown) {
  const match = markdown.match(/^#\s+(.+?)\s*$/m)
  return match?.[1].trim() || null
}

export function isPlaceholderName(name) {
  const normalized = name.trim()
  return (
    /^(name|todo|char|character|user|player|persona)(\s+name)?$/i.test(normalized) ||
    /^\{\{\s*(char|user)\s*\}\}$/i.test(normalized)
  )
}

export function expandRpgVariables(markdown, { charName, userName }) {
  return markdown
    .replaceAll('{{char}}', charName)
    .replaceAll('{{user}}', userName)
}

export function buildRpgSystemPrompt({ char, user, prompt, scenario, charName, userName }) {
  const sections = [
    '# Roleplay mode — fixed for this conversation',
    `You are roleplaying as **${charName}**.`,
    `The user is roleplaying as **${userName}**.`,
    `Speak and act only as ${charName}. Never speak, act, or decide for ${userName}.`,
    '---',
    '## Tone, world, and rules',
    prompt,
    '---',
    `## Character: ${charName}`,
    char,
    '---',
    `## User: ${userName}`,
    user,
    '---',
    '## Scenario',
    scenario,
    '---',
    '## Every turn',
    `- The latest user message is ${userName}'s input.`,
    `- Reply as ${charName}, in character, under the rules above.`,
    '- Do not prefix replies with a character name.',
  ]
  return `${sections.join('\n\n')}\n`
}

async function ensureTemplates(dir) {
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    throw new CliError(`Error: could not create RPG directory ${dir}: ${err.message}`)
  }

  const created = []
  for (const file of RPG_FILES) {
    try {
      await writeFile(join(dir, file), TEMPLATES[file], { flag: 'wx' })
      created.push(file)
    } catch (err) {
      if (err.code === 'EEXIST') continue
      throw new CliError(`Error: could not create ${join(dir, file)}: ${err.message}`)
    }
  }
  return created
}

async function readRpgFiles(dir) {
  const [charRaw, userRaw, promptRaw, scenarioRaw, firstMessageRaw] = await Promise.all(
    RPG_FILES.map(async (file) => {
      try {
        return await readFile(join(dir, file), 'utf8')
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw fileError(file, `is missing; run --rpg ${dir} again to create it.`)
        }
        throw new CliError(`Error: could not read ${join(dir, file)}: ${err.message}`)
      }
    })
  )

  for (const [file, raw] of [['char.md', charRaw], ['user.md', userRaw], ['prompt.md', promptRaw], ['scenario.md', scenarioRaw], ['first-message.md', firstMessageRaw]]) {
    if (!raw.trim()) {
      throw fileError(file, 'is empty. Fill it in, then delete the setup comment at the top.')
    }
    if (raw.includes(RPG_TEMPLATE_MARKER)) {
      throw fileError(file, 'still contains the setup comment. Fill in the file and delete the comment at the top.')
    }
  }

  const charHeading = headingName(charRaw)
  const userHeading = headingName(userRaw)
  const charName = charHeading || 'Character'
  const userName = userHeading || 'User'
  if (charHeading && isPlaceholderName(charHeading)) {
    throw fileError('char.md', `still has placeholder "# ${charHeading}". Replace it with the character's name.`)
  }
  if (userHeading && isPlaceholderName(userHeading)) {
    throw fileError('user.md', `still has placeholder "# ${userHeading}". Replace it with the user's name.`)
  }

  const expand = (markdown) => stripMarkdownComments(expandRpgVariables(markdown, { charName, userName }))
  const firstMessage = expand(firstMessageRaw)
  if (firstMessage.toUpperCase().includes(RPG_FIRST_MESSAGE_PLACEHOLDER)) {
    throw fileError('first-message.md', 'still contains the setup placeholder. Replace it with the opening message.')
  }
  return {
    char: expand(charRaw),
    user: expand(userRaw),
    prompt: expand(promptRaw),
    scenario: expand(scenarioRaw),
    firstMessage,
    charName,
    userName,
  }
}

export async function loadRpgContext(dir) {
  const created = await ensureTemplates(dir)
  if (created.length > 0) {
    return { created: true, dir, createdFiles: created }
  }

  const files = await readRpgFiles(dir)
  return {
    created: false,
    dir,
    ...files,
    systemPrompt: buildRpgSystemPrompt(files),
    history: await loadRpgHistory(dir),
  }
}

// The conversation log lives in the RPG directory so the story continues on
// the next --rpg run. The system prompt is deliberately not stored: it is
// rebuilt from the current Markdown files on every launch, so edits to the
// story files apply to resumed conversations too.
export async function saveRpgHistory(dir, messages) {
  const turns = messages.filter((m) => m.role !== 'system')
  if (turns.length === 0) return
  try {
    await writeFileAtomic(join(dir, RPG_HISTORY_FILE), JSON.stringify({ updatedAt: new Date().toISOString(), messages: turns }, null, 2) + '\n')
  } catch (err) {
    console.error(`Warning: could not save RPG history: ${err.message}`)
  }
}

export async function loadRpgHistory(dir) {
  const filePath = join(dir, RPG_HISTORY_FILE)
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    console.warn(`Warning: could not read RPG history ${filePath}: ${err.message}`)
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) return null
    return parsed.messages
  } catch {
    console.warn(`Warning: RPG history file is corrupt: ${filePath}; starting fresh.`)
    return null
  }
}
