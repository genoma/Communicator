import { spawn } from 'node:child_process'

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
      const timer = setTimeout(() => {
        settled = true
        child.kill()
        tryNext(index + 1)
      }, timeoutMs)
      let settled = false
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
