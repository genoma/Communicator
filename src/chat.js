import { createInterface } from "node:readline";
import { chatCompletion } from "./openrouter.js";

export async function startChat(apiKey, model, providerName) {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
  ];

  const label = providerName ? `${providerName} / ${model}` : model;
  console.log(`\nConnected to ${label}`);
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

    let fullResponse = "";

    try {
      process.stdout.write("\n");
      fullResponse = await chatCompletion(apiKey, model, messages, (token) => {
        process.stdout.write(token);
      }, providerName);
      process.stdout.write("\n\n");
    } catch (err) {
      console.error(`\nError: ${err.message}\n`);
      if (err.message.includes("Rate limited")) {
        messages.pop();
      }
      rl.prompt();
      continue;
    }

    if (fullResponse) {
      messages.push({ role: "assistant", content: fullResponse });
    }

    rl.prompt();
  }
}
