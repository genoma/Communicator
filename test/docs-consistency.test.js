import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS_DIR = join(ROOT, 'docs')

async function readText(relPath) {
  return readFile(join(ROOT, relPath), 'utf8')
}

function sectionBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker, start + 1)
  if (start === -1 || end === -1) return ''
  return text.slice(start, end)
}

function parseFlagSpec(spec) {
  const parts = spec.split(',').map((s) => s.trim())
  const tokens = []
  for (const part of parts) {
    const m = part.match(/^-{1,2}[\w-]+/)
    if (m) tokens.push(m[0])
  }
  const long = tokens.find((t) => t.startsWith('--'))
  const short = tokens.find((t) => !t.startsWith('--'))
  let args = null
  const longPart = parts.find((p) => p.startsWith('--'))
  const argsMatch = longPart?.match(/--[\w-]+\s+(\S+)/)
  if (argsMatch) args = argsMatch[1]
  return { short, long, args }
}

function extractCodeFlags(source) {
  const flags = new Map()
  const re = /\.option\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/g
  let m
  while ((m = re.exec(source)) !== null) {
    const { short, long, args } = parseFlagSpec(m[1])
    flags.set(long, { short, long, args, description: m[2] })
  }
  flags.set('--version', { short: '-V', long: '--version', args: null, description: 'Print the version and exit' })
  flags.set('--help', { short: '-h', long: '--help', args: null, description: 'Display help for command' })
  return flags
}

function extractProviderTypes(source) {
  const match = source.match(/const registry = \{ ([^}]+) \}/)
  if (!match) return []
  return match[1].split(',').map((s) => s.trim()).filter(Boolean)
}

function extractDocsFlags(commandsDoc) {
  const section = sectionBetween(commandsDoc, '## CLI flags', '## Usage examples')
  const rows = []
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.replace(/`/g, '').trim())
    if (!/^--[a-z]/.test(cells[2] || '')) continue
    rows.push({ short: cells[1], long: cells[2], args: cells[3], description: cells[4] })
  }
  return rows
}

function extractSlashCommands(commandsDoc) {
  const section = sectionBetween(commandsDoc, '## Slash commands', 'Unknown slash commands')
  const commands = []
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.replace(/`/g, '').trim())
    if (cells[1]?.startsWith('/')) commands.push(cells[1].split(/\s+/)[0])
  }
  return commands
}

function extractImageSessionCommands(source) {
  const fnStart = source.indexOf('function imageSessionCommands')
  if (fnStart === -1) return []
  const fnEnd = source.indexOf('\n}', fnStart)
  const fnBody = fnEnd === -1 ? source.slice(fnStart) : source.slice(fnStart, fnEnd)
  return [...fnBody.matchAll(/'(\/[a-z][a-z-]*)'/g)].map((m) => m[1])
}

function headingAnchor(heading) {
  return heading.trim().toLowerCase().replace(/`/g, '').replace(/[^a-z0-9\s_-]/g, '').replace(/-+/g, '-').replace(/\s/g, '-')
}

function extractHeadings(text) {
  const anchors = new Set()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.*)$/)
    if (m) anchors.add(headingAnchor(m[1]))
  }
  return anchors
}

test('CLI flags are bidirectionally consistent with docs/commands.md', async () => {
  const [codeSource, commandsDoc] = await Promise.all([readText('index.js'), readText('docs/commands.md')])
  const codeFlags = extractCodeFlags(codeSource)
  const docFlags = extractDocsFlags(commandsDoc)
  const documented = new Set(docFlags.map((f) => f.long))
  const declared = new Set(codeFlags.keys())

  const documentedButMissing = [...documented].filter((f) => !declared.has(f))
  const declaredButUndocumented = [...declared].filter((f) => !documented.has(f))

  assert.deepEqual(documentedButMissing, [], `Documented flags missing from index.js: ${documentedButMissing.join(', ')}`)
  assert.deepEqual(declaredButUndocumented, [], `Flags declared in index.js but not documented: ${declaredButUndocumented.join(', ')}`)

  for (const row of docFlags) {
    if (!row.short) continue
    const code = codeFlags.get(row.long)
    assert.equal(code?.short, row.short, `Short flag for ${row.long} differs (doc: ${row.short}, code: ${code?.short})`)
  }
})

test('slash commands are bidirectionally consistent with the docs', async () => {
  const [commandsDoc, devDoc, imageDoc, imageSessionSource, chatIndex] = await Promise.all([
    readText('docs/commands.md'),
    readText('docs/development.md'),
    readText('docs/images.md'),
    readText('src/commands/image-session.js'),
    import('../src/commands/chat/index.js'),
  ])
  const chatCommands = chatIndex.CHAT_COMMANDS
  const imageSessionCommands = extractImageSessionCommands(imageSessionSource)
  const expected = new Set([...chatCommands, ...imageSessionCommands])
  const documented = extractSlashCommands(commandsDoc)

  const documentedButUnknown = [...new Set(documented)].filter((c) => !expected.has(c))
  const chatButUndocumented = chatCommands.filter((c) => !documented.includes(c))
  assert.deepEqual(documentedButUnknown, [], `Documented slash commands not implemented: ${documentedButUnknown.join(', ')}`)
  assert.deepEqual(chatButUndocumented, [], `Implemented chat commands not documented: ${chatButUndocumented.join(', ')}`)

  const imageOnly = imageSessionCommands.filter((c) => !chatCommands.includes(c))
  for (const cmd of imageOnly) {
    assert.ok(imageDoc.includes(cmd), `Image-session command ${cmd} is not mentioned in docs/images.md`)
  }

  const countMatch = devDoc.match(/\((\d+) chatCommands\)/)
  assert.ok(countMatch, 'development.md must state the chat command count as "(N chatCommands)"')
  assert.equal(Number(countMatch[1]), chatCommands.length, 'development.md chat command count is stale')

  const proseMatch = devDoc.match(/the (\d+) slash commands live/)
  assert.ok(proseMatch, 'development.md must state the chat command count in prose')
  assert.equal(Number(proseMatch[1]), chatCommands.length, 'development.md prose chat command count is stale')
})

test('env vars, data paths, and node version are documented', async () => {
  const [readme, platformsDoc, chatDoc, sessionsDoc, prefsDoc, packageJson] = await Promise.all([
    readText('README.md'),
    readText('docs/platforms.md'),
    readText('docs/chat.md'),
    readText('docs/sessions.md'),
    readText('docs/preferences.md'),
    readFile(join(ROOT, 'package.json'), 'utf8').then(JSON.parse),
  ])
  const { getProvider } = await import('../src/providers/index.js')
  const providerSource = await readText('src/providers/index.js')
  const providerTypes = extractProviderTypes(providerSource)
  assert.ok(providerTypes.length > 0, 'providers/index.js must declare a registry object')
  const { DEFAULT_CONFIG_FILE, DEFAULT_SYSTEM_PROMPT_FILE, SESSIONS_DIR } = await import('../src/constants.js')

  for (const type of providerTypes) {
    const envVar = getProvider(type).meta.apiKeyEnv
    for (const [name, text] of [['README.md', readme], ['docs/platforms.md', platformsDoc]]) {
      assert.ok(text.includes(envVar), `${envVar} must be mentioned in ${name}`)
    }
  }

  const pathExpectations = [
    {
      token: `~/${basename(DEFAULT_CONFIG_FILE)}`,
      files: [['README.md', readme], ['docs/platforms.md', platformsDoc], ['docs/preferences.md', prefsDoc]],
    },
    {
      token: `~/${basename(DEFAULT_SYSTEM_PROMPT_FILE)}`,
      files: [['docs/platforms.md', platformsDoc], ['docs/chat.md', chatDoc]],
    },
    {
      token: `~/${basename(dirname(SESSIONS_DIR))}/${basename(SESSIONS_DIR)}`,
      files: [['README.md', readme], ['docs/platforms.md', platformsDoc], ['docs/sessions.md', sessionsDoc]],
    },
  ]
  for (const { token, files } of pathExpectations) {
    for (const [name, text] of files) {
      assert.ok(text.includes(token), `${token} must be mentioned in ${name}`)
    }
  }

  const versionNum = packageJson.engines.node.match(/\d+\.\d+/)[0]
  for (const [name, text] of [['README.md', readme], ['docs/platforms.md', platformsDoc]]) {
    assert.ok(text.includes(versionNum), `Node.js ${versionNum} must be mentioned in ${name}`)
  }
})

test('key defaults and enum values are mentioned in the docs', async () => {
  const docFiles = (await readdir(DOCS_DIR)).filter((f) => f.endsWith('.md'))
  const docTexts = await Promise.all(docFiles.map((f) => readText(join('docs', f))))
  const corpus = (await readText('README.md')) + docTexts.join('\n')

  const [constants, flags, cliUtils] = await Promise.all([
    import('../src/constants.js'),
    import('../src/flags.js'),
    import('../src/cli-utils.js'),
  ])

  const backtickList = (values) => '`' + values.join('`, `') + '`'
  const tokens = [
    ['default temperature', String(constants.DEFAULT_TEMPERATURE)],
    ['max temperature', `0-${constants.MAX_TEMPERATURE}`],
    ['default web search results', `default ${constants.DEFAULT_WEB_SEARCH_RESULTS}`],
    ['max web search results', String(constants.MAX_WEB_SEARCH_RESULTS)],
    ['smooth speed slow preset', String(constants.SMOOTH_SPEED_PRESETS.slow)],
    ['smooth speed normal preset', String(constants.SMOOTH_SPEED_PRESETS.normal)],
    ['smooth speed fast preset', String(constants.SMOOTH_SPEED_PRESETS.fast)],
    ['smooth default speed', constants.SMOOTH_DEFAULT_SPEED],
    ['max image dimension', String(flags.MAX_IMAGE_DIMENSION)],
    ['image generation timeout', `${constants.IMAGE_GEN_TIMEOUT_MS / 60000} minutes`],
    ['image seed bound', String(flags.MAX_SEED)],
    ['image attachment limit', `${constants.MAX_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)} MB`],
    ['file attachment limit', `${constants.MAX_FILE_ATTACHMENT_BYTES / (1024 * 1024)} MB`],
    ['inline text attachment limit', `${constants.MAX_INLINE_TEXT_ATTACHMENT_BYTES / 1024} KB`],
    ['piped stdin limit', `${cliUtils.MAX_STDIN_BYTES / (1024 * 1024)}MB`],
    ['reasoning effort levels', backtickList(Object.keys(constants.EFFORT_LABELS))],
    ['image formats', backtickList([...flags.IMAGE_FORMATS])],
    ['image resolutions', backtickList([...flags.IMAGE_RESOLUTIONS])],
    ['image qualities', backtickList([...flags.IMAGE_QUALITIES])],
    ['web search modes', backtickList([...flags.WEB_SEARCH_MODES])],
  ]

  for (const [label, token] of tokens) {
    assert.ok(corpus.includes(token), `${label} (${token}) is not mentioned in README.md or docs/`)
  }
})

test('flags used in docs/commands.md examples all exist', async () => {
  const [commandsDoc, codeSource] = await Promise.all([readText('docs/commands.md'), readText('index.js')])
  const codeFlags = extractCodeFlags(codeSource)
  const valid = new Set([...codeFlags.keys(), ...[...codeFlags.values()].map((f) => f.short).filter(Boolean)])

  const used = new Set()
  for (const fence of commandsDoc.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const m of fence[1].matchAll(/(?:^|\s)(--[\w-]+)|(?:^|\s)-([a-zA-Z])(?=\s|$)/g)) {
      used.add(m[1] || `-${m[2]}`)
    }
  }

  const unknown = [...used].filter((f) => !valid.has(f))
  assert.deepEqual(unknown, [], `Flags used in examples but not declared: ${unknown.join(', ')}`)
})

test('markdown links resolve to existing files and anchors', async () => {
  const files = ['README.md', ...(await readdir(DOCS_DIR)).filter((f) => f.endsWith('.md')).map((f) => join('docs', f))]
  const texts = new Map()
  const readTextCached = async (rel) => {
    if (!texts.has(rel)) {
      texts.set(rel, await readFile(join(ROOT, rel), 'utf8').catch(() => null))
    }
    return texts.get(rel)
  }

  const problems = []
  for (const file of files) {
    const text = (await readTextCached(file)).replace(/```[\s\S]*?```/g, '')
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = m[1].trim()
      if (/^(https?:|mailto:|data:)/.test(target)) continue
      if (!target.includes('.') && !target.startsWith('#')) continue
      const [pathPart, anchor] = target.split('#')
      const abs = pathPart
        ? normalize(join(dirname(join(ROOT, file)), pathPart))
        : join(ROOT, file)
      const rel = relative(ROOT, abs)
      if (rel.startsWith(`..${sep}`) || rel === '..') {
        problems.push(`${file}: link ${target} resolves outside the repo`)
        continue
      }
      const targetText = await readTextCached(rel)
      if (targetText === null) {
        problems.push(`${file}: link ${target} resolves to missing file ${rel}`)
        continue
      }
      if (anchor && !extractHeadings(targetText).has(anchor)) {
        problems.push(`${file}: link ${target} has no matching heading for anchor #${anchor}`)
      }
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'))
})
