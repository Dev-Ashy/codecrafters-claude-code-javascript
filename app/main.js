import { readFile } from "node:fs/promises";
import OpenAI from "openai";

async function main() {
  const [, , flag, prompt] = process.argv;
  // CodeCrafters sets OPENROUTER_API_KEY and OPENROUTER_BASE_URL when it runs your tests.
  // To run your program locally, set OPENROUTER_API_KEY to your own OpenRouter key.
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  // CodeCrafters sets OPENROUTER_MODEL to anthropic/claude-haiku-4.5 when it runs your tests. Locally, you can set it to any model.
  const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-haiku-4.5";

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. CodeCrafters sets it when you run `codecrafters test` or `codecrafters submit`. To run your program directly, set it to your own OpenRouter key.",
    );
  }
  if (flag !== "-p" || !prompt) {
    throw new Error("error: -p flag is required");
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
  });

  const tools = [
    {
      type: "function",
      function: {
        name: "Read",
        description: "Read and return the contents of a file",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "The path to the file to read",
            },
          },
          required: ["file_path"],
        },
      },
    },
  ];

  const messages = [{ role: "user", content: prompt }];

  while (true) {
    const response = await client.chat.completions.create({
      model: model,
      messages: messages,
      tools: tools,
    });

    if (!response.choices || response.choices.length === 0) {
      throw new Error("no choices in response");
    }

    const message = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls?.length) {
      console.log(message.content);
      break;
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.function.name !== "Read") {
        throw new Error(`unsupported tool: ${toolCall.function.name}`);
      }

      const args = JSON.parse(toolCall.function.arguments);
      const content = await readFile(args.file_path, "utf8");

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: content,
      });
    }
  }
}

main();
