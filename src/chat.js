import { createInterface } from "node:readline";
import { chatCompletion } from "./openrouter.js";

export async function startChat(apiKey, model, providerName, reasoningEffort) {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
  ];

  const label = providerName ? `${providerName} / ${model}` : model;
  if (reasoningEffort) {
    const { getEffortLabel } = await import("./prompts.js");
    console.log(`\nConnected to ${label}  [thinking: ${getEffortLabel(reasoningEffort)}]`);
  } else {
    console.log(`\nConnected to ${label}`);
  }
  console.log('Type your message and press Enter. "/quit" or Ctrl+C to exit.\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }

    if (input === "/quit") {
      rl.close();
      return;
    }

    messages.push({ role: "user", content: input });

    let result;

    try {
      process.stdout.write("\n");
      result = await chatCompletion(apiKey, model, messages, (token, type) => {
        if (type === "start_reasoning") {
          shownThinkingBanner = true;
          process.stdout.write("\x1b[90m[Thinking]\x1b[0m\n");
          process.stdout.write(token);
        } else if (type === "reasoning") {
          process.stdout.write(`\x1b[90m${token}\x1b[0m`);
        } else if (type === "end_reasoning") {
          process.stdout.write("\n\n\x1b[1m[Answer]\x1b[0m\n\n");
        } else if (type === "content") {
          process.stdout.write(token);
        }
      }, providerName, reasoningEffort);
      process.stdout.write("\n\n");
    } catch (err) {
      console.error(`\nError: ${err.message}\n`);
      if (err.message.includes("Rate limited")) {
        messages.pop();
      }
      rl.prompt();
      continue;
    }

    if (result.content) {
      const msg = { role: "assistant", content: result.content };
      if (result.reasoning) {
        msg.reasoning = result.reasoning;
      }
      messages.push(msg);
    }

    rl.prompt();
  }
}
