import { THIN_SEP } from "../constants.js"

const DIM_OPEN = "\x1b[90m"
const BOLD_OPEN = "\x1b[1m"
const RESET = "\x1b[0m"

export function dim(text) {
  return text ? `${DIM_OPEN}${text}${RESET}` : ""
}

export function bold(text) {
  return `${BOLD_OPEN}${text}${RESET}`
}

export function thinking() {
  return dim("[Thinking]")
}

export function answer() {
  return bold("[Answer]")
}

export function sep() {
  return dim(THIN_SEP)
}
