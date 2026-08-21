import { styleText } from 'node:util'
import { THIN_SEP } from '../constants.js'
import { sanitizeSingleLine } from './hyperlink.js'

export const dim = (text) => styleText('dim', text)
export const bold = (text) => styleText('bold', text)
export const italic = (text) => styleText('italic', text)
export const green = (text) => styleText('green', text)
export const yellow = (text) => styleText('yellow', text)
export const red = (text) => styleText('red', text)
export const cyan = (text) => styleText('cyan', text)

export function you(name = 'You') {
  return styleText(['bold', 'cyan'], `❯ ${sanitizeSingleLine(name)}`)
}

export function char(name) {
  return styleText(['bold', 'green'], `❯ ${sanitizeSingleLine(name)}`)
}

export function thinking() {
  return styleText(['dim', 'yellow'], '❯ Thinking')
}

export function answer() {
  return styleText(['bold', 'green'], '❯ Answer')
}

export function sep() {
  return dim(THIN_SEP)
}
