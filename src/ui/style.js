import { styleText } from 'node:util'
import { THIN_SEP } from '../constants.js'

export const dim = (text) => styleText('dim', text)
export const bold = (text) => styleText('bold', text)
export const italic = (text) => styleText('italic', text)

export function you() {
  return styleText(['bold', 'cyan'], '❯ You')
}

export function thinking() {
  return styleText(['dim', 'yellow'], '[Thinking]')
}

export function answer() {
  return styleText(['bold', 'green'], '[Answer]')
}

export function sep() {
  return dim(THIN_SEP)
}
