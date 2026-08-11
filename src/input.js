import { join } from 'node:path'
import { readMultiline } from './vendor/read-multiline/index.js'
import { matchCommands } from './suggest.js'
import { DATA_DIR } from './constants.js'

const HISTORY_PATH = join(DATA_DIR, 'history.json')

export async function readInput({ commands } = {}) {
  const input = process.stdin
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      input.removeListener('end', onEof)
      input.removeListener('close', onEof)
      resolve(value)
    }
    const onEof = () => finish({ cancelled: true, eof: true })
    if (input.readableEnded || input.destroyed) {
      finish({ cancelled: true, eof: true })
      return
    }
    if (input.isTTY) {
      input.on('end', onEof)
      input.on('close', onEof)
    }
    readMultiline('', {
      prefix: '',
      linePrefix: '❯ ',
      helpFooter: true,
      maxLines: 50,
      history: {
        filePath: HISTORY_PATH,
        maxEntries: 200,
        shouldPersist: (v) => v.trim() !== '',
      },
      theme: {
        linePrefix: { pending: 'cyan', submitted: 'dim', cancelled: 'dim' },
        submitRender: 'preserve',
      },
      suggest: commands
        ? ({ value }) => matchCommands(value, commands)
        : undefined,
    }).then(
      ([value, error]) => {
        if (error) {
          if (error.kind === 'cancel') return finish({ cancelled: true, partial: value })
          if (error.kind === 'eof') return finish({ cancelled: true, eof: true })
          return finish({ cancelled: true })
        }
        finish({ value })
      },
      () => finish({ cancelled: true })
    )
  })
}
