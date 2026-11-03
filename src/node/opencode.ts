export interface OpenCodePermission {
  id: string;
  action: string;
  resources: string[];
}

export interface OpenCodeRunDeps {
  chatId: number;
  model?: string;
  systemContext?: string;
  signal?: AbortSignal;
  onPartial: (text: string) => void;
  askApproval: (command: string, reason: string) => Promise<boolean>;
  onPermission?: (permission: OpenCodePermission, approved: boolean) => void;
  onRecover?: () => void;
}

export interface OpenCodeConfig {
  url: string;
  password: string;
  defaultModel?: string;
  workDir?: string;
  timeoutMs?: number;
  pollMs?: number;
}

const RULESET = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "write", resource: "*", effect: "ask" },
  { action: "read", resource: "*", effect: "ask" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
];

const REASONING_ERROR = /reasoning_content/i;

function splitModel(model: string): { providerID: string; id: string } {
  const index = model.indexOf("/");
  if (index <= 0) return { providerID: "opencode", id: model };
  return { providerID: model.slice(0, index), id: model.slice(index + 1) };
}

interface EventLike {
  type?: string;
  data?: {
    sessionID?: string;
    delta?: string;
    error?: unknown;
  };
}

export class OpenCodeRunner {
  private config: Required<OpenCodeConfig>;
  private sessions = new Map<number, string>();
  private primedSessions = new Set<string>();

  constructor(config: OpenCodeConfig) {
    this.config = {
      url: config.url,
      password: config.password,
      defaultModel: config.defaultModel || "opencode/glm-5.3-flash-free",
      workDir: config.workDir || "/",
      timeoutMs: config.timeoutMs ?? 900_000,
      pollMs: config.pollMs ?? 700,
    };
  }

  setEndpoint(url: string, password: string): void {
    this.config.url = url;
    this.config.password = password;
  }

  getSession(chatId: number): string | null {
    return this.sessions.get(chatId) ?? null;
  }

  setSession(chatId: number, sessionId: string): void {
    this.sessions.set(chatId, sessionId);
  }

  clearSession(chatId: number): void {
    const existing = this.sessions.get(chatId);
    if (existing) this.primedSessions.delete(existing);
    this.sessions.delete(chatId);
  }

  private authHeader(): string {
    const token = Buffer.from(`opencode:${this.config.password}`).toString("base64");
    return `Basic ${token}`;
  }

  private async api<T = unknown>(
    method: string,
    pathUrl: string,
    body?: unknown
  ): Promise<{ status: number; data?: T; raw: string }> {
    const response = await fetch(`${this.config.url}${pathUrl}`, {
      method,
      headers: {
        authorization: this.authHeader(),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    const raw = await response.text();
    let data: T | undefined;
    if (raw !== "") {
      try {
        const parsed = JSON.parse(raw) as { data?: T };
        data = (parsed as { data?: T }).data ?? (parsed as T);
      } catch {
        data = undefined;
      }
    }
    return { status: response.status, data, raw };
  }

  private async createSession(chatId: number, wantedModel: string): Promise<string> {
    const model = splitModel(wantedModel);
    const created = await this.api<{ id?: string }>("POST", "/api/session", {
      title: `telegram-${chatId}`,
      location: { directory: this.config.workDir },
      model,
      permissions: RULESET,
    });

    const id = created.data?.id;
    if (!id) {
      throw new Error(`gagal buat session: ${created.status} ${created.raw.slice(0, 200)}`);
    }

    this.sessions.set(chatId, id);
    return id;
  }

  private async ensureSession(chatId: number, wantedModel: string): Promise<string> {
    const existing = this.sessions.get(chatId);

    if (existing !== undefined) {
      const check = await this.api<{ model?: { id?: string; providerID?: string } }>(
        "GET",
        `/api/session/${existing}`
      );
      if (check.status === 200) {
        const current = check.data?.model;
        const currentRef = current?.providerID && current?.id ? `${current.providerID}/${current.id}` : "";
        if (currentRef === wantedModel) return existing;
        console.log(`[opencode] model berubah (${currentRef || "?"} -> ${wantedModel}), buat session baru`);
      } else {
        console.warn(`[opencode] session ${existing} hilang, buat baru`);
      }
    }

    return this.createSession(chatId, wantedModel);
  }

  async listModels(): Promise<string[]> {
    if (!this.config.url || !this.config.password) {
      throw new Error("server OpenCode belum jalan");
    }
    const result = await this.api<Array<{ providerID?: string; modelID?: string; id?: string }>>(
      "GET",
      "/api/model"
    );
    if (result.status !== 200 || !Array.isArray(result.data)) {
      throw new Error(`gagal ambil daftar model: ${result.status} ${result.raw.slice(0, 120)}`);
    }
    return result.data
      .filter((item) => item.providerID && (item.modelID ?? item.id))
      .map((item) => `${item.providerID}/${item.modelID ?? item.id}`)
      .sort();
  }

  async run(prompt: string, deps: OpenCodeRunDeps): Promise<string> {
    if (this.config.password === "") {
      throw new Error("OPENCODE_PASSWORD kosong — jalankan server dengan password tetap");
    }
    if (this.config.url === "") {
      throw new Error("server OpenCode belum jalan (OPENCODE_URL kosong dan server terkelola belum start)");
    }

    if (deps.signal?.aborted) throw new Error("ABORTED");
    const wantedModel = deps.model || this.config.defaultModel;
    const sessionId = await this.ensureSession(deps.chatId, wantedModel);

    try {
      return await this.runInSession(prompt, deps, sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!REASONING_ERROR.test(message)) throw error;

      console.warn(`[opencode] riwayat tidak kompatibel (reasoning_content), buat session baru`);
      this.clearSession(deps.chatId);
      deps.onRecover?.();
      const fresh = await this.createSession(deps.chatId, wantedModel);
      return this.runInSession(prompt, deps, fresh);
    }
  }

  private async runInSession(prompt: string, deps: OpenCodeRunDeps, sessionId: string): Promise<string> {
    let text = "";
    let finished = false;
    let failure: string | null = null;
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const streamAbort = new AbortController();
    deps.signal?.addEventListener("abort", () => streamAbort.abort(), { once: true });
    const stream = await fetch(`${this.config.url}/api/event`, {
      headers: { authorization: this.authHeader() },
      signal: streamAbort.signal,
    });

    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let event: EventLike;
            try {
              event = JSON.parse(line.slice(6)) as EventLike;
            } catch {
              continue;
            }
            if (event.data?.sessionID !== sessionId) continue;

            if (event.type === "session.text.delta" && event.data?.delta) {
              text += event.data.delta;
              deps.onPartial(text);
            } else if (event.type === "session.execution.succeeded") {
              finished = true;
              resolveDone();
            } else if (event.type === "session.execution.failed") {
              failure = JSON.stringify(event.data?.error ?? "execution failed").slice(0, 300);
              finished = true;
              resolveDone();
            }
          }
        }
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (!finished && name !== "AbortError") console.error("[opencode] stream error:", error);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, Math.min(this.config.pollMs, 200)));
    let effectivePrompt = prompt;
    if (deps.systemContext && !this.primedSessions.has(sessionId)) {
      effectivePrompt = `${deps.systemContext}\n\nPermintaan operator:\n${prompt}`;
    }
    const promptResult = await this.api("POST", `/api/session/${sessionId}/prompt`, { text: effectivePrompt });
    if (promptResult.status >= 400) {
      streamAbort.abort();
      throw new Error(`prompt gagal: ${promptResult.status} ${promptResult.raw.slice(0, 200)}`);
    }
    this.primedSessions.add(sessionId);

    const deadline = Date.now() + this.config.timeoutMs;
    try {
      while (!finished && Date.now() < deadline) {
        const pending = await this.api<OpenCodePermission[]>(
          "GET",
          `/api/session/${sessionId}/permission`
        );

        for (const request of pending.data ?? []) {
          const resources = request.resources ?? [];
          const command = resources.join(" ; ");
          const approved = await deps.askApproval(command, `opencode: ${request.action}`);
          deps.onPermission?.(request, approved);

          await this.api(
            "POST",
            `/api/session/${sessionId}/permission/${request.id}/reply`,
            { decision: approved ? "once" : "reject" }
          );

          if (!approved) {
            await this.api("POST", `/api/session/${sessionId}/interrupt`, {});
            return "⛔ [REJECTED] Ditolak oleh operator.";
          }
        }

        if (deps.signal?.aborted) {
          await this.api("POST", `/api/session/${sessionId}/interrupt`, {});
          throw new Error("ABORTED");
        }
        await Promise.race([done, new Promise((resolve) => setTimeout(resolve, this.config.pollMs))]);
      }
    } finally {
      streamAbort.abort();
    }

    if (!finished) {
      await this.api("POST", `/api/session/${sessionId}/interrupt`, {});
      throw new Error("opencode timeout — eksekusi dihentikan");
    }
    if (failure !== null) throw new Error(failure);

    const result = text.trim();
    return result !== "" ? result : "(opencode selesai tanpa teks)";
  }
}
