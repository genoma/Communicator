import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CliError } from './errors.js'
import { writeFileAtomic } from './fs-utils.js'

export const RPG_FILES = ['char.md', 'user.md', 'prompt.md', 'scenario.md', 'first-message.md']
export const RPG_POST_HISTORY_FILE = 'post-history-instruction.md'
export const RPG_TEMPLATE_MARKER = 'RPG_TEMPLATE'
export const RPG_FIRST_MESSAGE_PLACEHOLDER = 'RPG_FIRST_MESSAGE_TODO'
export const RPG_HISTORY_FILE = 'history.json'
export const RPG_PROMPT_LOG_FILE = 'prompt-log.jsonl'

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

export function isPlaceholderName(name) {
  const normalized = name.trim()
  return (
    /^(name|todo|char|character|user|player|persona)(\s+name)?$/i.test(normalized) ||
    /^\{\{\s*(char|user)\s*\}\}$/i.test(normalized)
  )
}

export function expandRpgVariables(markdown, { charName, userName }) {
  return markdown
    .replaceAll('{{char}}', () => charName)
    .replaceAll('{{user}}', () => userName)
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
    '## Character',
    char,
    '---',
    '## User',
    user,
    '---',
    '## Scenario',
    scenario,
    '---',
    '## Every turn',
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
  for (const file of [...RPG_FILES, RPG_POST_HISTORY_FILE]) {
    try {
      // The post-history instruction starts empty on purpose: it is optional
      // and an empty file disables the feature, so there is no template to
      // fill in or sentinel comment to delete.
      await writeFile(join(dir, file), file === RPG_POST_HISTORY_FILE ? '' : TEMPLATES[file], { flag: 'wx', mode: 0o600 })
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

  // Headings are read from the comment-stripped text so a commented-out
  // heading (e.g. the template's "# Name" kept inside a note) can neither
  // steal the name nor trigger a false placeholder error.
  const charHeading = parseRpgName(stripMarkdownComments(charRaw), null)
  const userHeading = parseRpgName(stripMarkdownComments(userRaw), null)
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

// The post-history instruction is optional: it is created empty during
// provisioning but unlike the five story files it is never templated or
// validated, and a missing or empty file simply disables the feature. It is
// deliberately NOT part of the system prompt — it is
// injected as a system message after the latest user message on every turn,
// where models weight instructions highest and long histories cannot dilute
// them (SillyTavern's "Post-History Instructions" pattern).
async function readRpgPostHistoryInstruction(dir, { charName, userName }) {
  let raw
  try {
    raw = await readFile(join(dir, RPG_POST_HISTORY_FILE), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new CliError(`Error: could not read ${join(dir, RPG_POST_HISTORY_FILE)}: ${err.message}`)
  }
  const instruction = stripMarkdownComments(expandRpgVariables(raw, { charName, userName })).trim()
  return instruction || null
}

export async function loadRpgContext(dir) {
  const created = await ensureTemplates(dir)
  // The optional post-history instruction may be created silently alongside
  // the templates, but only a missing story file triggers the setup exit.
  if (created.some((file) => RPG_FILES.includes(file))) {
    return { created: true, dir, createdFiles: created }
  }

  const files = await readRpgFiles(dir)
  const [saved, postHistoryInstruction] = await Promise.all([
    loadRpgHistory(dir),
    readRpgPostHistoryInstruction(dir, files),
  ])
  return {
    created: false,
    dir,
    ...files,
    systemPrompt: buildRpgSystemPrompt(files),
    postHistoryInstruction,
    history: saved?.messages ?? null,
    historyUpdatedAt: saved?.updatedAt ?? null,
  }
}

// The conversation log lives in the RPG directory so the story continues on
// the next --rpg run. The system prompt is deliberately not stored: it is
// rebuilt from the current Markdown files on every launch, so edits to the
// story files apply to resumed conversations too.
export async function saveRpgHistory(dir, messages) {
  const turns = messages.filter((m) => m.role !== 'system')
  // A session with no user turn yet (e.g. quitting right after the greeting)
  // must not create or touch the file: nothing worth resuming, and a
  // greeting-only log would freeze the opening message into the story.
  if (!turns.some((m) => m.role === 'user')) return
  try {
    await writeFileAtomic(join(dir, RPG_HISTORY_FILE), JSON.stringify({ updatedAt: new Date().toISOString(), messages: turns }, null, 2) + '\n')
  } catch (err) {
    console.error(`Warning: could not save RPG history: ${err.message}`)
  }
}

// The prompt log is a debug artifact: one JSON object per API request, with
// the exact request body the provider built. Plain append (not atomic) is
// deliberate — a single writer per run, and the file is meant to be tailed.
// A module-level promise chain serializes the appends so fast consecutive
// turns can never land out of order. Failures warn without throwing, like
// saveRpgHistory.
let logChain = Promise.resolve()
export function logRpgPrompt(dir, entry) {
  const line = JSON.stringify(entry) + '\n'
  logChain = logChain
    .catch(() => {})
    .then(async () => {
      try {
        await appendFile(join(dir, RPG_PROMPT_LOG_FILE), line, { mode: 0o600 })
        console.error(`[debug] prompt logged: ${join(dir, RPG_PROMPT_LOG_FILE)} (${line.length} bytes)`)
      } catch (err) {
        console.warn(`Warning: could not log prompt to ${join(dir, RPG_PROMPT_LOG_FILE)}: ${err.message}`)
      }
    })
  return logChain
}

function isValidHistoryMessage(m) {
  return (
    !!m &&
    typeof m === 'object' &&
    (m.role === 'user' || m.role === 'assistant') &&
    (typeof m.content === 'string' || Array.isArray(m.content))
  )
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
    const messages = parsed.messages.filter(isValidHistoryMessage)
    if (messages.length !== parsed.messages.length) {
      console.warn(`Warning: RPG history ${filePath} contains ${parsed.messages.length - messages.length} malformed message(s); ignoring them.`)
    }
    if (messages.length === 0) return null
    const updatedAt = typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt)) ? parsed.updatedAt : null
    return { messages, updatedAt }
  } catch {
    console.warn(`Warning: RPG history file is corrupt: ${filePath}; starting fresh.`)
    return null
  }
}
