export function isDebug() {
  const value = process.env.COMMUNICATOR_DEBUG
  return value === '1' || value === 'true'
}

export function out(str) {
  console.log(str)
}

export function err(str) {
  console.error(str)
}

export function debug(...args) {
  if (isDebug()) console.error('[debug]', ...args)
}
