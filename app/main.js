import { exec } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import OpenAI from "openai";

const execAsync = promisify(exec);

function frontmatterValue(value) {
  return value.replace(/^["']|["']$/g, "");
}

async function parseSkillMetadata(filePath, folderName) {
  const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return null;
  }

  const skill = {
    filePath,
    folderName,
    name: folderName,
    description: "",
    bodyStartLine: 0,
  };

  let index = 1;
  for (; index < lines.length && lines[index].trim() !== "---"; index++) {
    const match = lines[index].match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1].trim();
    const value = frontmatterValue(match[2].trim());
    if (key === "name") {
      skill.name = value;
    } else if (key === "description") {
      skill.description = value;
    }
  }

  skill.bodyStartLine = index + 1;
  return skill;
}

async function loadSkills() {
  const skillsDir = join(process.cwd(), ".claude", "skills");

  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }

    try {
      const skill = await parseSkillMetadata(
        join(skillsDir, entry.name, "SKILL.md"),
        entry.name,
      );
      if (skill) {
        skills.push(skill);
      }
    } catch {
      // Ignore directories without a readable SKILL.md.
    }
  }

  return skills;
}

async function readSkillBody(skill) {
  const lines = (await readFile(skill.filePath, "utf8")).split(/\r?\n/);
  return lines.slice(skill.bodyStartLine).join("\n").trim();
}

function substituteArguments(body, args) {
  return body.replace(
    /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)/g,
    (_match, indexed, shorthand) => {
      if (indexed !== undefined) {
        return args[Number(indexed)] ?? "";
      }
      if (shorthand !== undefined) {
        return args[Number(shorthand)] ?? "";
      }
      return args.join(" ");
    },
  );
}

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
    {
      type: "function",
      function: {
        name: "Skill",
        description: "Load a skill's instructions into the conversation",
        parameters: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              description: "The name of the skill to use",
            },
            args: {
              type: "string",
              description: "Optional arguments for the skill",
            },
          },
        },
      },
    },
  ];

  const skills = await loadSkills();
  const messages = [];

  if (skills.length > 0) {
    messages.push({
      role: "system",
      content:
        "You have access to the following skills:\n\n" +
        skills
          .map((skill) => `- ${skill.name}: ${skill.description}`)
          .join("\n") +
        "\n\nIf a skill matches the user's request, call the Skill tool with its name\n" +
        "and follow the instructions it returns.\n\n" +
        "When giving the final answer, follow the user's requested output format exactly. " +
        "If the user asks for a number, respond with only that number and no explanation.",
    });
  }

  const tokens = prompt.trim().split(/\s+/);
  const bodies = [];
  let index = 0;

  while (index < tokens.length && tokens[index].startsWith("/")) {
    const requestedSkill = tokens[index].slice(1);
    const skill = skills.find(
      (candidate) =>
        candidate.name === requestedSkill ||
        candidate.folderName === requestedSkill,
    );
    if (!skill) {
      break;
    }

    bodies.push(await readSkillBody(skill));
    index++;
  }

  if (bodies.length > 0) {
    const args = tokens.slice(index);
    for (const body of bodies) {
      messages.push({ role: "user", content: substituteArguments(body, args) });
    }
  } else {
    messages.push({ role: "user", content: prompt });
  }

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
        case "Skill":
          {
            const skill = skills.find(
              (candidate) =>
                candidate.name === args.name || candidate.folderName === args.name,
            );
            if (!skill) {
              result = `Unknown skill: ${args.name}`;
            } else {
              const skillArgs =
                typeof args.args === "string" && args.args.trim()
                  ? args.args.trim().split(/\s+/)
                  : [];
              result = substituteArguments(await readSkillBody(skill), skillArgs);
            }
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
