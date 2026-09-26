import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { MAX_IMAGE_ATTACHMENT_BYTES } from './constants.js'
import { classifyPath } from './attachments.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TIFF_SIGNATURES = [Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.from([0x4d, 0x4d, 0x00, 0x2a])]

const NO_IMAGE_ERROR = 'No image in the clipboard.'
const NO_TOOL_ERROR = 'No clipboard image tool found. Install wl-paste (wl-clipboard) or xclip.'
const READ_ERROR = 'Cannot read the clipboard image.'
const TOO_LARGE_ERROR = 'The clipboard image is larger than 20 MB.'
const STDOUT_CAPTURE_LIMIT = 8 * 1024

// AppleScript coerces any text into a file URL, so the flavor has to be checked
// before the coercion is attempted: only a real file URL passes this probe.
const FILE_URL_SCRIPT = [
  'set found to false',
  'repeat with entry in (clipboard info)',
  '  if (item 1 of entry is «class furl») then set found to true',
  'end repeat',
  'if not found then error number -1700',
  'return POSIX path of (the clipboard as «class furl»)',
].join('\n')

// The output path travels through the environment: TEMP can hold spaces and
// apostrophes, and interpolating it into PowerShell source would break on both.
const WINDOWS_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
  '$img = Get-Clipboard -Format Image',
  'if ($null -eq $img) { exit 1 }',
  '$img.Save($env:COMMUNICATOR_CLIP_OUT, [System.Drawing.Imaging.ImageFormat]::Png)',
].join('\n')

function clipboardCommands(platform = process.platform) {
  if (platform === 'darwin') return [['pbcopy']]
  if (platform === 'win32') return [['clip']]
  return [
    ['wl-copy'],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard']],
  ]
}

export function copyText(text, { platform = process.platform, timeoutMs = 10000 } = {}) {
  const commands = clipboardCommands(platform)
  return new Promise((resolve) => {
    const tryNext = (index) => {
      if (index >= commands.length) {
        resolve({ ok: false, error: 'No clipboard tool found. Install wl-copy, xclip, or xsel.' })
        return
      }
      const [cmd, args = []] = commands[index]
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        child.kill()
        tryNext(index + 1)
      }, timeoutMs)
      function cleanup() {
        clearTimeout(timer)
      }
      child.on('error', () => {
        if (settled) return
        settled = true
        cleanup()
        tryNext(index + 1)
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        cleanup()
        if (code === 0) resolve({ ok: true })
        else tryNext(index + 1)
      })
      // The tool may exit before stdin drains (EPIPE): treat that like a tool
      // failure and probe the next one instead of crashing the CLI.
      child.stdin.on('error', () => {
        if (settled) return
        settled = true
        cleanup()
        tryNext(index + 1)
      })
      try {
        child.stdin.write(text)
        child.stdin.end()
      } catch {
        if (settled) return
        settled = true
        cleanup()
        tryNext(index + 1)
      }
    }
    tryNext(0)
  })
}

function appleScriptClipboardWrite(flavor, target) {
  const escaped = target.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return [
    `set outputFile to POSIX file "${escaped}"`,
    'set fileRef to open for access outputFile with write permission',
    'set eof fileRef to 0',
    `write (the clipboard as «class ${flavor}») to fileRef`,
    'close access fileRef',
  ].join('\n')
}

function imageAttempts(platform, dir) {
  if (platform === 'darwin') {
    const pngTarget = join(dir, 'clip.png')
    const tiffTarget = join(dir, 'clip.tiff')
    return [
      { cmd: '/usr/bin/osascript', args: ['-e', FILE_URL_SCRIPT], captureStdout: true, fileUrl: true },
      { cmd: '/usr/bin/osascript', args: ['-e', appleScriptClipboardWrite('PNGf', pngTarget)], target: pngTarget, signature: 'png', mime: 'image/png' },
      { cmd: '/usr/bin/osascript', args: ['-e', appleScriptClipboardWrite('TIFF', tiffTarget)], target: tiffTarget, signature: 'tiff', mime: 'image/tiff' },
    ]
  }
  const pngTarget = join(dir, 'clip.png')
  if (platform === 'win32') {
    return [{
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-STA', '-Command', WINDOWS_SCRIPT],
      env: { ...process.env, COMMUNICATOR_CLIP_OUT: pngTarget },
      target: pngTarget,
      signature: 'png',
      mime: 'image/png',
    }]
  }
  return [
    { cmd: 'wl-paste', args: ['--type', 'image/png'], target: join(dir, 'clip-wl.png'), pipeStdout: true, signature: 'png', mime: 'image/png' },
    { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], target: join(dir, 'clip-xclip.png'), pipeStdout: true, signature: 'png', mime: 'image/png' },
  ]
}

function runAttempt(attempt, timeoutMs) {
  return new Promise((resolve) => {
    let fd = null
    let stdio = 'ignore'
    if (attempt.pipeStdout) {
      try {
        fd = openSync(attempt.target, 'w')
      } catch {
        resolve({ outcome: 'io-failed', stdout: '' })
        return
      }
      stdio = ['ignore', fd, 'ignore']
    } else if (attempt.captureStdout) {
      stdio = ['ignore', 'pipe', 'ignore']
    }
    let settled = false
    let child = null
    let stdout = ''
    let overflowed = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // The child may already have closed the inherited descriptor.
        }
      }
      resolve({ outcome, stdout })
    }
    const timer = setTimeout(() => {
      if (settled) return
      if (child) child.kill('SIGKILL')
      finish('failed')
    }, timeoutMs)
    try {
      child = spawn(attempt.cmd, attempt.args, { stdio, env: attempt.env })
    } catch {
      finish('failed')
      return
    }
    if (attempt.captureStdout) {
      child.stdout?.on('data', (chunk) => {
        if (overflowed) return
        stdout += chunk
        if (stdout.length > STDOUT_CAPTURE_LIMIT) overflowed = true
      })
    }
    child.on('error', (err) => finish(err?.code === 'ENOENT' ? 'missing' : 'failed'))
    child.on('close', (code) => finish(code === 0 && !overflowed ? 'exited' : 'failed'))
  })
}

async function readClipboardFileUrl(text) {
  const path = text.trim()
  if (!path || !isAbsolute(path)) return null
  const { kind, mime } = classifyPath(path)
  if (kind !== 'image') return null
  const info = await stat(path).catch(() => null)
  if (!info || info.size === 0) return null
  if (info.size > MAX_IMAGE_ATTACHMENT_BYTES) return { oversized: true }
  const data = await readFile(path).catch(() => null)
  if (!data || data.length === 0) return null
  if (data.length > MAX_IMAGE_ATTACHMENT_BYTES) return { oversized: true }
  return { data, mime, filename: basename(path) }
}

function isUsableImage(buffer, signature) {
  if (!buffer || buffer.length === 0 || buffer.length > MAX_IMAGE_ATTACHMENT_BYTES) return false
  if (signature === 'png') return buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  return TIFF_SIGNATURES.some((magic) => buffer.subarray(0, magic.length).equals(magic))
}

export async function readClipboardImage({ platform = process.platform, timeoutMs = 10000, tmpdir: tempRoot = osTmpdir() } = {}) {
  let dir
  try {
    dir = await mkdtemp(join(tempRoot, 'communicator-clipboard-'))
  } catch {
    return { ok: false, error: READ_ERROR }
  }
  try {
    let sawTool = false
    let sawOversized = false
    for (const attempt of imageAttempts(platform, dir)) {
      const { outcome, stdout } = await runAttempt(attempt, timeoutMs)
      if (outcome === 'io-failed') return { ok: false, error: READ_ERROR }
      if (outcome === 'missing') continue
      sawTool = true
      if (outcome !== 'exited') continue
      if (attempt.fileUrl) {
        const file = await readClipboardFileUrl(stdout)
        if (file?.oversized) {
          sawOversized = true
          continue
        }
        if (!file) continue
        return { ok: true, ...file }
      }
      // A killed or failed attempt can leave bytes that pass the magic check:
      // only an exit code 0 makes the file trustworthy.
      const info = await stat(attempt.target).catch(() => null)
      if (!info || info.size === 0) continue
      if (info.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        sawOversized = true
        continue
      }
      const data = await readFile(attempt.target).catch(() => null)
      if (!isUsableImage(data, attempt.signature)) continue
      return { ok: true, data, mime: attempt.mime }
    }
    if (sawOversized) return { ok: false, error: TOO_LARGE_ERROR }
    return { ok: false, error: sawTool ? NO_IMAGE_ERROR : NO_TOOL_ERROR }
  } catch {
    return { ok: false, error: READ_ERROR }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
