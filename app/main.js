import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import OpenAI from "openai";

const execAsync = promisify(exec);

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
    {
      type: "function",
      function: {
        name: "Write",
        description: "Write content to a file",
        parameters: {
          type: "object",
          required: ["file_path", "content"],
          properties: {
            file_path: {
              type: "string",
              description: "The path of the file to write to",
            },
            content: {
              type: "string",
              description: "The content to write to the file",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "Bash",
        description: "Execute a shell command",
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: {
              type: "string",
              description: "The command to execute",
            },
          },
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
      const args = JSON.parse(toolCall.function.arguments);
      let result;

      switch (toolCall.function.name) {
        case "Read":
          result = await readFile(args.file_path, "utf8");
          break;
        case "Write":
          await mkdir(dirname(args.file_path), { recursive: true });
          await writeFile(args.file_path, args.content, "utf8");
          result = `Successfully wrote to ${args.file_path}`;
          break;
        case "Bash":
          try {
            const { stdout, stderr } = await execAsync(args.command, {
              cwd: process.cwd(),
            });
            result = [stdout, stderr].filter(Boolean).join("\n");
          } catch (error) {
            const output = [error.stdout, error.stderr]
              .filter(Boolean)
              .join("\n");
            result = `Command failed: ${args.command}\n${output || error.message}`;
          }
          break;
        default:
          throw new Error(`unsupported tool: ${toolCall.function.name}`);
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }
}

main();
