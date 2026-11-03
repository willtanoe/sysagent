import OpenAI from "openai";
import { NodeExecutor, RequestApprovalFn } from "./executor";

export interface EngineOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export class NodeEngine {
  private executor: NodeExecutor;
  private openai?: OpenAI;
  private defaultModel: string;
  private nodeId: string;

  constructor(nodeId: string, executor: NodeExecutor, opts?: EngineOptions) {
    this.nodeId = nodeId;
    this.executor = executor;
    this.defaultModel = opts?.model || "ag/gemini-3.8-flash";

    const key = opts?.apiKey || process.env.GATEWAY_API_KEY || process.env.OPENAI_API_KEY;
    const base = opts?.baseURL || process.env.GATEWAY_BASE_URL || process.env.OPENAI_BASE_URL;

    if (key) {
      this.openai = new OpenAI({
        apiKey: key,
        baseURL: base,
      });
    }
  }

  async run(
    prompt: string,
    onChunk: (text: string) => void,
    requestApproval: RequestApprovalFn,
    modelOverride?: string
  ): Promise<string> {
    const trimmed = prompt.trim();

    // 1. Jika mode ops langsung / tidak ada LLM key terkonfigurasi, atau jika prompt diawali prefix '$ ' atau perintah langsung
    if (!this.openai || trimmed.startsWith("$ ")) {
      const cmd = trimmed.startsWith("$ ") ? trimmed.slice(2).trim() : trimmed;
      onChunk(`[${this.nodeId}] Menjalankan: \`${cmd}\`...\n`);
      const res = await this.executor.runCommand(cmd, requestApproval);
      const out = `\`\`\`\n${res.output}\n\`\`\` (exit ${res.exitCode}, ${res.durationMs}ms)`;
      onChunk(out);
      return `[${this.nodeId}]\n${out}`;
    }

    // 2. Mode LLM dengan Tool Calling (execute_shell)
    const model = modelOverride || this.defaultModel;
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `Anda adalah Aster Sysadmin Agent yang berjalan di node VPS "${this.nodeId}". Gunakan tool execute_shell untuk menginspeksi atau mengelola server ini. Jawab dengan gaya ops ringkas, bahasa Indonesia santai.`,
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    const tools: OpenAI.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "execute_shell",
          description: "Menjalankan perintah shell bash di VPS node ini.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description: "Perintah shell bash.",
              },
            },
            required: ["command"],
          },
        },
      },
    ];

    try {
      let turn = 0;
      let finalContent = "";

      while (turn < 5) {
        turn++;
        const resp = await this.openai.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: "auto",
        });

        const choice = resp.choices[0];
        if (!choice) break;

        const msg = choice.message;
        messages.push(msg);

        if (msg.content) {
          finalContent += msg.content;
          onChunk(msg.content);
        }

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          break;
        }

        for (const tool of msg.tool_calls) {
          if (tool.function.name === "execute_shell") {
            let cmd = "";
            try {
              const parsed = JSON.parse(tool.function.arguments);
              cmd = parsed.command;
            } catch {
              cmd = tool.function.arguments;
            }

            onChunk(`\n[${this.nodeId}] ⚙️ \`${cmd}\`...\n`);
            const execRes = await this.executor.runCommand(cmd, requestApproval);

            messages.push({
              role: "tool",
              tool_call_id: tool.id,
              content: execRes.output,
            });
          }
        }
      }

      return finalContent || `[${this.nodeId}] Selesai.`;
    } catch (err: any) {
      // Fallback jika API LLM gagal/kuota habis: jalankan sebagai ops langsung jika berupa perintah
      const errMsg = `[${this.nodeId}] LLM error (${err.message}). Mencoba eksekusi ops langsung...`;
      onChunk(errMsg + "\n");
      const execRes = await this.executor.runCommand(trimmed, requestApproval);
      return `${errMsg}\n\`\`\`\n${execRes.output}\n\`\`\``;
    }
  }
}
