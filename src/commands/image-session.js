import { readInput as readInputFromInput } from '../input.js'
import { persistSessionFile } from '../sessions.js'
import { savePreferences, applyPreferenceUpdates } from '../config.js'
import { findImageModel } from '../model-selection.js'
import { CliError, formatError } from '../errors.js'
import { runImageGeneration, printImageOutcome, buildImageSessionPayload } from './image-gen.js'

const IMAGE_SESSION_COMMANDS = ['/help', '/exit', '/quit']

export async function startImageSession({ provider, apiKey, prefs, imageModelId, sessionId, createdAt, initialMessages = [], configPath, stdout = process.stdout, readInput: read = readInputFromInput }) {
  const model = await findImageModel(provider, apiKey, imageModelId)
  if (!model) {
    throw new CliError(`Error: image model ${imageModelId} is no longer available. Use --list-image-models to see available models.`)
  }

  let messages = initialMessages.length > 0 ? [...initialMessages] : [{ role: 'system', content: 'You are a helpful assistant.' }]
  const persist = () => persistSessionFile(sessionId, buildImageSessionPayload({ messages, modelId: imageModelId, createdAt }))

  console.log(`Image session with ${imageModelId}. Describe an image to generate it; /help lists the available commands.\n`)

  while (true) {
    const result = await read({ commands: IMAGE_SESSION_COMMANDS })
    if (result.cancelled) {
      await persist()
      return
    }

    const input = result.value.trim()
    if (!input) continue

    if (input === '/exit' || input === '/quit') {
      await persist()
      return
    }

    if (input === '/help') {
      console.log('/help          show this help')
      console.log('/exit, /quit   leave the session')
      continue
    }

    if (input.startsWith('/')) {
      console.log(`Unknown command "${input}". Available: ${IMAGE_SESSION_COMMANDS.join(', ')}`)
      continue
    }

    let outcome
    try {
      outcome = await runImageGeneration({ provider, apiKey, prompt: input, opts: {}, prefs, sessionId, model, stdout })
    } catch (err) {
      console.error(err instanceof CliError ? `\n${err.message}\n` : `\nError: ${formatError(err)}\n`)
      continue
    }

    messages.push({ role: 'user', content: input })
    messages.push(outcome.message)
    await persist()
    await savePreferences(applyPreferenceUpdates(prefs, { lastImageModel: outcome.modelId }), configPath)
    printImageOutcome(outcome, stdout)
  }
}
