import { exec } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import OpenAI from "openai";
import { LSPClient } from "./lsp_client.js";

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
    fork: false,
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
    } else if (key === "context") {
      skill.fork = value === "fork";
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

class Agent {
  constructor(client, model, tools, skills, lspClient = null) {
    this.client = client;
    this.model = model;
    this.tools = tools;
    this.skills = skills;
    this.lspClient = lspClient;
    this.openedUris = new Set();
  }

  findSkill(name) {
    return this.skills.find(
      (candidate) => candidate.name === name || candidate.folderName === name,
    );
  }

  lspDocument(filePath) {
    const absolutePath = resolve(process.cwd(), filePath);
    return { absolutePath, uri: pathToFileURL(absolutePath).href };
  }

  lspPosition(args) {
    return { line: args.line - 1, character: args.character - 1 };
  }

  relativePath(uri) {
    return relative(process.cwd(), fileURLToPath(uri)).split(sep).join("/");
  }

  async ensureDocumentOpen(uri) {
    if (this.openedUris.has(uri)) {
      return;
    }

    const filePath = fileURLToPath(uri);
    const text = await readFile(filePath, "utf8");
    const languageId =
      this.lspClient.extensionToLanguage?.[extname(filePath)] ?? "plaintext";

    await this.lspClient.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    });

    this.openedUris.add(uri);
  }

  async goToDefinition(args) {
    const { uri } = this.lspDocument(args.filePath);
    await this.ensureDocumentOpen(uri);

    const definition = await this.lspClient.request("textDocument/definition", {
      textDocument: { uri },
      position: this.lspPosition(args),
    });

    const definedPath = this.relativePath(definition.uri);
    const { line, character } = definition.range.start;
    return `Defined in ${definedPath}:${line + 1}:${character + 1}`;
  }

  async findReferences(args) {
    const { uri } = this.lspDocument(args.filePath);
    await this.ensureDocumentOpen(uri);

    const locations = await this.lspClient.request("textDocument/references", {
      textDocument: { uri },
      position: this.lspPosition(args),
      context: { includeDeclaration: true },
    });

    if (!locations || locations.length === 0) {
      return "No references found.";
    }

    const byFile = new Map();
    for (const location of locations) {
      const path = this.relativePath(location.uri);
      const { line, character } = location.range.start;
      if (!byFile.has(path)) {
        byFile.set(path, []);
      }
      byFile.get(path).push(`  Line ${line + 1}:${character + 1}`);
    }

    const fileCount = byFile.size;
    const lines = [
      `Found ${locations.length} reference${locations.length === 1 ? "" : "s"} ` +
        `across ${fileCount} file${fileCount === 1 ? "" : "s"}:`,
      "",
    ];
    for (const [path, positions] of byFile) {
      lines.push(`${path}:`, ...positions, "");
    }
    return lines.join("\n").trimEnd();
  }

  async executeTool(name, args) {
    switch (name) {
      case "Read":
        return await readFile(args.file_path, "utf8");
      case "Write":
        await mkdir(dirname(args.file_path), { recursive: true });
        await writeFile(args.file_path, args.content, "utf8");
        return `Successfully wrote to ${args.file_path}`;
      case "Bash":
        try {
          const { stdout, stderr } = await execAsync(args.command, {
            cwd: process.cwd(),
          });
          return [stdout, stderr].filter(Boolean).join("\n");
        } catch (error) {
          const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
          return `Command failed: ${args.command}\n${output || error.message}`;
        }
      case "Skill": {
        const skill = this.findSkill(args.name);
        if (!skill) {
          return `Unknown skill: ${args.name}`;
        }
        const skillArgs =
          typeof args.args === "string" && args.args.trim()
            ? args.args.trim().split(/\s+/)
            : [];
        const body = substituteArguments(
          await readSkillBody(skill),
          skillArgs,
        );

        if (!skill.fork) {
          return body;
        }

        const answer = await this.run([{ role: "user", content: body }]);
        return `Skill ${skill.name} ran in a separate context and returned: ${answer}`;
      }
      case "LSP":
        if (!this.lspClient) {
          return "LSP client is not configured";
        }
        if (args.operation === "goToDefinition") {
          return await this.goToDefinition(args);
        }
        if (args.operation === "findReferences") {
          return await this.findReferences(args);
        }
        return `Unsupported LSP operation: ${args.operation}`;
      default:
        throw new Error(`unsupported tool: ${name}`);
    }
  }

  async run(messages) {
    while (true) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: messages,
        tools: this.tools,
      });

      if (!response.choices || response.choices.length === 0) {
        throw new Error("no choices in response");
      }

      const message = response.choices[0].message;
      messages.push(message);

      if (!message.tool_calls?.length) {
        return message.content ?? "";
      }

      for (const toolCall of message.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await this.executeTool(toolCall.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }
  }
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

  const lspClient = await LSPClient.fromEnvironment();
  if (lspClient) {
    console.error("LSP client connected");
  }

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

  if (lspClient) {
    tools.push({
      type: "function",
      function: {
        name: "LSP",
        description:
          "Find a symbol's definition or all references to it. Use " +
          "goToDefinition for the file, line, and character where the symbol " +
          "is defined, and findReferences for every location that references " +
          "the symbol. Line and character are 1-based, as in an editor.",
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["goToDefinition", "findReferences"],
              description:
                "goToDefinition finds where the symbol is defined; " +
                "findReferences finds all uses of the symbol.",
            },
            filePath: {
              type: "string",
              description:
                "Absolute path, or a path relative to the agent's current working directory.",
            },
            line: {
              type: "integer",
              minimum: 1,
              description: "1-based line number of the symbol.",
            },
            character: {
              type: "integer",
              minimum: 1,
              description:
                "1-based character offset in UTF-16 code units (same as character count for ASCII).",
            },
          },
          required: ["operation", "filePath", "line", "character"],
        },
      },
    });
  }

  const skills = await loadSkills();
  const agent = new Agent(client, model, tools, skills, lspClient);
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
  const invokedSkills = [];
  let index = 0;

  while (index < tokens.length && tokens[index].startsWith("/")) {
    const requestedSkill = tokens[index].slice(1);
    const skill = agent.findSkill(requestedSkill);
    if (!skill) {
      break;
    }

    invokedSkills.push(skill);
    index++;

    if (skill.fork) {
      break;
    }
  }

  if (invokedSkills.length > 0) {
    const args = tokens.slice(index);
    for (const skill of invokedSkills) {
      const body = substituteArguments(await readSkillBody(skill), args);
      if (skill.fork) {
        const answer = await agent.run([{ role: "user", content: body }]);
        messages.push({
          role: "user",
          content: `Skill ${skill.name} ran in a separate context and returned: ${answer}`,
        });
      } else {
        messages.push({ role: "user", content: body });
      }
    }
  } else {
    messages.push({ role: "user", content: prompt });
  }

  console.log(await agent.run(messages));
}

main();
