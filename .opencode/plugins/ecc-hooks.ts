/**
 * ECC Plugin Hooks for OpenCode (V2 plugin API)
 *
 * OpenCode 2.x loads a plugin as an object with a stable `id` and a `setup`
 * function. Hooks are registered on the domain that owns the operation:
 *
 * - tool.execute.before/after  → ctx.tool.hook("execute.before"/"execute.after")
 * - shell.env                  → ctx.shell.hook("create.before")
 * - session compaction         → ctx.session.hook("compaction")
 * - session/file events        → ctx.event.subscribe()
 * - custom tools               → ctx.tool.transform()
 *
 * Permission decisions are intentionally not overridden here: Aster Node's
 * OpenCodeRunner replies to permission requests through the API after the
 * operator approval step, so this plugin must never auto-approve a tool.
 */

import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

type HookProfile = "minimal" | "standard" | "strict"

interface ToolHookEvent {
  tool: string
  sessionID?: string
  agent?: string
  messageID?: string
  id?: string
  input?: Record<string, unknown>
  status?: "completed" | "error"
  result?: { content?: unknown; output?: unknown; metadata?: Record<string, unknown> }
  error?: { message?: string }
}

interface ShellCreateBefore {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}

interface PluginContext {
  location?: { directory?: string }
  tool: {
    hook(name: "execute.before" | "execute.after", callback: (event: ToolHookEvent) => unknown): Promise<unknown>
    transform(callback: (editor: { add(tool: unknown): void }) => void): Promise<unknown>
  }
  shell: {
    hook(name: "create.before", callback: (event: ShellCreateBefore) => unknown): Promise<unknown>
  }
  session: {
    hook(name: "compaction", callback: (event: { system: Array<{ type: "text"; text: string }> }) => unknown): Promise<unknown>
  }
  event: {
    subscribe(options: { types: string[]; signal: AbortSignal }): AsyncIterable<{ type: string; data?: unknown }>
  }
}

const PROFILE_ORDER: Record<HookProfile, number> = {
  minimal: 0,
  standard: 1,
  strict: 2,
}

function normalizeProfile(value: string | undefined): HookProfile {
  if (value === "minimal" || value === "strict") return value
  return "standard"
}

function filePathOf(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  const candidate = input.filePath ?? input.file_path ?? input.path
  return typeof candidate === "string" && candidate.trim() ? candidate : null
}

function commandOf(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  const candidate = input.command
  return typeof candidate === "string" ? candidate : ""
}

function readPackageVersion(startDir: string): string {
  let current = startDir
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf-8"))
      if (typeof pkg.version === "string" && pkg.version) return pkg.version
    } catch {
      // Try the parent directory.
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return "unknown"
}

function findEccRoot(startDir: string): string | null {
  const probes = [
    path.join("scripts", "lib", "resolve-ecc-root.js"),
    path.join("scripts", "lib", "utils.js"),
  ]
  let current = startDir
  for (let depth = 0; depth < 5; depth += 1) {
    if (probes.every((probe) => fs.existsSync(path.join(current, probe)))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function countConsoleLogs(filePath: string): number {
  try {
    const source = fs.readFileSync(filePath, "utf-8")
    return source.match(/console\.log/g)?.length ?? 0
  } catch {
    return 0
  }
}

export default {
  id: "aster.ecc-hooks",

  async setup(ctx: PluginContext): Promise<() => void> {
    const directory = ctx.location?.directory || process.cwd()
    const currentProfile = normalizeProfile(process.env.ECC_HOOK_PROFILE)
    const disabledHooks = new Set(
      (process.env.ECC_DISABLED_HOOKS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )

    const hookEnabled = (
      hookId: string,
      required: HookProfile | HookProfile[] = "standard"
    ): boolean => {
      if (disabledHooks.has(hookId)) return false
      if (Array.isArray(required)) {
        return required.some((entry) => PROFILE_ORDER[currentProfile] >= PROFILE_ORDER[entry])
      }
      return PROFILE_ORDER[currentProfile] >= PROFILE_ORDER[required]
    }

    const log = (level: "info" | "warn" | "debug", message: string): void => {
      const line = `[ECC] ${message}`
      if (level === "warn") console.warn(line)
      else if (level === "info") console.log(line)
      else console.debug(line)
    }

    const resolvePath = (filePath: string): string =>
      path.isAbsolute(filePath) ? filePath : path.join(directory, filePath)

    const hasProjectFile = (relativePath: string): boolean => {
      try {
        return fs.statSync(path.join(directory, relativePath)).isFile()
      } catch {
        return false
      }
    }

    const editedFiles = new Set<string>()
    const pendingWrites = new Map<string, { path: string; type: "added" | "modified" }>()

    // The changed-files store and the tool barrel are loaded dynamically so a
    // partial install only disables that capability instead of crashing the
    // plugin (and with it the whole session) at startup.
    let store: typeof import("./lib/changed-files-store.ts") | undefined
    try {
      store = await import("./lib/changed-files-store.ts")
      store.initStore(directory)
    } catch {
      log("warn", "changed-files tracking disabled: could not load the changed-files store.")
    }

    let toolModules: typeof import("../tools/index.ts") | undefined
    try {
      toolModules = await import("../tools/index.ts")
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      log("warn", `custom tools disabled: could not load ../tools/index.ts (${message})`)
    }

    await ctx.tool.hook("execute.before", async (event: ToolHookEvent) => {
      if (event.tool === "write") {
        const filePath = filePathOf(event.input)
        if (filePath) {
          let type: "added" | "modified" = "modified"
          try {
            type = fs.existsSync(resolvePath(filePath)) ? "modified" : "added"
          } catch {
            type = "modified"
          }
          const key = event.id ?? `write:${filePath}`
          pendingWrites.set(key, { path: filePath, type })
        }
      }

      if (
        hookEnabled("pre:bash:git-push-reminder", "strict") &&
        event.tool === "bash" &&
        commandOf(event.input).includes("git push")
      ) {
        log("info", "Remember to review changes before pushing: git diff origin/main...HEAD")
      }

      if (hookEnabled("pre:write:doc-file-warning", ["standard", "strict"]) && event.tool === "write") {
        const filePath = filePathOf(event.input)
        if (
          filePath &&
          filePath.match(/\.(md|txt)$/i) &&
          !filePath.includes("README") &&
          !filePath.includes("CHANGELOG") &&
          !filePath.includes("LICENSE") &&
          !filePath.includes("CONTRIBUTING")
        ) {
          log("warn", `Creating ${filePath} - consider if this documentation is necessary`)
        }
      }

      if (hookEnabled("pre:bash:tmux-reminder", "strict") && event.tool === "bash") {
        const command = commandOf(event.input)
        if (
          command.match(/^(npm|pnpm|yarn|bun)\s+(install|build|test|run)/) ||
          command.match(/^cargo\s+(build|test|run)/) ||
          command.match(/^go\s+(build|test|run)/)
        ) {
          log("info", "Long-running command detected - consider using background execution")
        }
      }
    })

    await ctx.tool.hook("execute.after", async (event: ToolHookEvent) => {
      const filePath = filePathOf(event.input)

      if (event.tool === "edit" && filePath) {
        store?.recordChange(filePath, "modified")
      }

      if (event.tool === "write" && filePath) {
        const key = event.id ?? `write:${filePath}`
        const pending = pendingWrites.get(key)
        if (pending) {
          store?.recordChange(pending.path, pending.type)
          pendingWrites.delete(key)
        } else {
          store?.recordChange(filePath, "modified")
        }
      }

      if (
        hookEnabled("post:edit:typecheck", ["strict"]) &&
        (event.tool === "edit" || event.tool === "write") &&
        filePath?.match(/\.tsx?$/)
      ) {
        try {
          await execFileAsync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc", "--noEmit"], {
            cwd: directory,
            timeout: 120_000,
          })
          log("info", "TypeScript check passed")
        } catch (error: unknown) {
          const err = error as { stdout?: string; message?: string }
          log("warn", "TypeScript errors detected:")
          const details = (err.stdout || err.message || "").split("\n").filter(Boolean).slice(0, 5)
          details.forEach((line) => log("warn", `  ${line}`))
        }
      }

      if (
        hookEnabled("post:bash:pr-created", ["standard", "strict"]) &&
        event.tool === "bash" &&
        commandOf(event.input).includes("gh pr create")
      ) {
        log("info", "PR created - check GitHub Actions status")
      }
    })

    await ctx.shell.hook("create.before", (event: ShellCreateBefore) => {
      const env: Record<string, string> = {
        ECC_VERSION: readPackageVersion(directory),
        ECC_PLUGIN: "true",
        ECC_HOOK_PROFILE: currentProfile,
        ECC_DISABLED_HOOKS: process.env.ECC_DISABLED_HOOKS || "",
        PROJECT_ROOT: directory,
      }

      const lockfiles: Record<string, string> = {
        "bun.lockb": "bun",
        "pnpm-lock.yaml": "pnpm",
        "yarn.lock": "yarn",
        "package-lock.json": "npm",
      }
      for (const [lockfile, packageManager] of Object.entries(lockfiles)) {
        if (hasProjectFile(lockfile)) {
          env.PACKAGE_MANAGER = packageManager
          break
        }
      }

      const langDetectors: Record<string, string> = {
        "tsconfig.json": "typescript",
        "go.mod": "go",
        "pyproject.toml": "python",
        "Cargo.toml": "rust",
        "Package.swift": "swift",
      }
      const detected: string[] = []
      for (const [file, language] of Object.entries(langDetectors)) {
        if (hasProjectFile(file)) detected.push(language)
      }
      if (detected.length > 0) {
        env.DETECTED_LANGUAGES = detected.join(",")
        env.PRIMARY_LANGUAGE = detected[0]
      }

      // Only advertise a root that actually contains the ECC resolver, and
      // never replace a root that the user or an earlier plugin already set.
      const rootAlreadySet = Boolean(
        (process.env.CLAUDE_PLUGIN_ROOT || "").trim() || (event.env.CLAUDE_PLUGIN_ROOT || "").trim()
      )
      const eccRoot = rootAlreadySet ? null : findEccRoot(directory)
      if (eccRoot) env.CLAUDE_PLUGIN_ROOT = eccRoot

      Object.assign(event.env, env)
    })

    await ctx.session.hook("compaction", (event: { system: Array<{ type: "text"; text: string }> }) => {
      const lines = [
        "# ECC Context",
        "",
        "Preserve: current task status, key decisions, files created/modified, remaining work, security concerns.",
        "Discard: verbose tool output, intermediate exploration, redundant file listings.",
        "",
      ]
      if (editedFiles.size > 0) {
        lines.push("## Recently Edited Files")
        for (const file of editedFiles) lines.push(`- ${file}`)
        lines.push("")
      }
      event.system.push({ type: "text", text: lines.join("\n") })
    })

    if (toolModules) {
      const entries: Array<[string, { description: string; input: Record<string, unknown>; execute: Function } | undefined]> = [
        ["run_tests", toolModules.runTests],
        ["check_coverage", toolModules.checkCoverage],
        ["security_audit", toolModules.securityAudit],
        ["format_code", toolModules.formatCode],
        ["lint_check", toolModules.lintCheck],
        ["git_summary", toolModules.gitSummary],
        ["changed_files", toolModules.changedFiles],
        ["dependency_analyzer", toolModules.dependencyAnalyzer],
      ]

      await ctx.tool.transform((editor) => {
        for (const [name, definition] of entries) {
          if (!definition) continue
          editor.add({
            name,
            description: definition.description,
            input: definition.input,
            execute: async (input: Record<string, unknown>, toolContext: Record<string, unknown>) => {
              const result = await definition.execute(input, {
                ...toolContext,
                directory,
                worktree: directory,
              })
              return { content: typeof result === "string" ? result : JSON.stringify(result) }
            },
          })
        }
      })
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["filesystem.changed", "session.created", "session.idle", "session.deleted"],
          signal: controller.signal,
        })) {
          switch (event.type) {
            case "filesystem.changed": {
              const data = event.data as
                | { file?: string; event?: "add" | "change" | "unlink" }
                | undefined
              const file = data?.file
              if (!file) break
              const changeType =
                data?.event === "add" ? "added" : data?.event === "unlink" ? "deleted" : "modified"
              editedFiles.add(file)
              store?.recordChange(file, changeType)

              if (hookEnabled("post:edit:format", ["strict"]) && file.match(/\.(ts|tsx|js|jsx)$/)) {
                try {
                  await execFileAsync("prettier", ["--write", file], { cwd: directory, timeout: 60_000 })
                  log("info", `Formatted: ${file}`)
                } catch (error: unknown) {
                  const message = error instanceof Error ? error.message : String(error)
                  log("debug", `Prettier formatting failed for ${file}: ${message}`)
                }
              }

              if (
                hookEnabled("post:edit:console-warn", ["standard", "strict"]) &&
                file.match(/\.(ts|tsx|js|jsx)$/)
              ) {
                const count = countConsoleLogs(resolvePath(file))
                if (count > 0) {
                  log("warn", `console.log found in ${file} (${count} occurrence${count > 1 ? "s" : ""})`)
                }
              }
              break
            }
            case "session.created":
              if (hookEnabled("session:start", ["minimal", "standard", "strict"])) {
                log("info", `Session started - profile=${currentProfile}`)
                if (hasProjectFile("CLAUDE.md")) log("info", "Found CLAUDE.md - loading project context")
              }
              break
            case "session.idle": {
              if (!hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) break
              if (editedFiles.size === 0) break

              let total = 0
              const filesWithLogs: string[] = []
              for (const file of editedFiles) {
                if (!file.match(/\.(ts|tsx|js|jsx)$/)) continue
                const count = countConsoleLogs(resolvePath(file))
                if (count > 0) {
                  total += count
                  filesWithLogs.push(file)
                }
              }

              if (total > 0) {
                log("warn", `Audit: ${total} console.log statement(s) in ${filesWithLogs.length} file(s)`)
                filesWithLogs.forEach((file) => log("warn", `  - ${file}`))
                log("warn", "Remove console.log statements before committing")
              } else {
                log("info", "Audit passed: No console.log statements found")
              }

              editedFiles.clear()
              break
            }
            case "session.deleted":
              if (hookEnabled("session:end-marker", ["minimal", "standard", "strict"])) {
                log("info", "Session ended - cleaning up")
              }
              editedFiles.clear()
              pendingWrites.clear()
              store?.clearChanges()
              break
          }
        }
      } catch {
        // The subscription is aborted during plugin cleanup; nothing to do.
      }
    })()

    return () => controller.abort()
  },
}
