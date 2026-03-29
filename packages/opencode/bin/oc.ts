#!/usr/bin/env bun
// oc — Calls back into the running openCode instance from bash scripts.
// Deterministic tool calls use the shell fast-path (bin/oc); this binary
// handles complex operations: prompt, agent, todo, status, and tool fallback.

import { Effect, Schema } from "effect"
import { resolve, normalize, relative } from "path"

class ServerError extends Schema.TaggedErrorClass<ServerError>()("ServerError", { message: Schema.String }) {}
class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}
class ApiError extends Schema.TaggedErrorClass<ApiError>()("ApiError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

interface ExecBody extends Record<string, unknown> {
  prompt: string
  system?: string
  agent?: string
  messageID?: string
  model?: { providerID: string; modelID: string }
  files?: Array<{ filename: string; mime: string; url: string }>
}

interface ToolBody extends Record<string, unknown> {
  name: string
  args: Record<string, unknown>
  agent: string
  messageID?: string
}

interface StatusBody extends Record<string, unknown> {
  message: string
  messageID?: string
}

interface TodoBody extends Record<string, unknown> {
  content: string
  status: string
}

interface TodoUpdateBody extends Record<string, unknown> {
  todos: Array<{ content: string; status: string; priority: string }>
}

const server = process.env.OPENCODE_SERVER_URL
const sid = process.env.OPENCODE_SESSION_ID
const dir = process.env.OPENCODE_DIRECTORY ?? process.cwd()
const msg = process.env.OPENCODE_MESSAGE_ID
const quiet = process.env.OPENCODE_QUIET === "1"
const isRalphLoop = process.env.OPENCODE_RALPH_LOOP === "1"

// Security: Path validation to prevent path traversal attacks
const sanitizePath = (path: string): string => {
  if (!path || path.trim() === "") {
    throw new ValidationError({ message: "Invalid path: empty or null" })
  }

  const normalizedPath = normalize(path)
  const resolvedPath = resolve(dir, normalizedPath)

  // Ensure the resolved path is within the working directory
  const rel = relative(dir, resolvedPath)
  if (rel.startsWith("../") || rel === "..") {
    throw new ValidationError({ message: `Path traversal attempt blocked: ${path}` })
  }

  return resolvedPath
}

const marker = "\x00OC_FILE\x00:"
const trunc = "\x00OC_TRUNCATED\x00:"

const mimes: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
}

const log = (label: string) => {
  if (!quiet) process.stderr.write(`\x1b[2m[oc] ${label}\x1b[0m\n`)
}

const parse = (model: string) => {
  const i = model.indexOf("/")
  if (i < 0) return undefined
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) }
}

const api = Effect.fn("oc.api")((method: string, path: string, body?: Record<string, unknown>) =>
  Effect.gen(function* () {
    if (!server)
      return yield* new ServerError({
        message: "OPENCODE_SERVER_URL not set — are you running inside an openCode bash tool?",
      })

    const res = yield* Effect.tryPromise({
      try: () => {
        // For exec operations (oc check, oc prompt), use no timeout to support Ralph loops
        // For tool operations, use shorter timeout since they should be fast
        const isExecOperation = path.includes("/exec")
        const controller = new AbortController()
        let timeoutId: Timer | undefined

        if (!isExecOperation) {
          // Tool operations get 60 second timeout
          timeoutId = setTimeout(() => controller.abort(), 60_000)
        }
        // Exec operations get no timeout (infinite) to support Ralph loops

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-opencode-directory": encodeURIComponent(dir),
        }

        // Add Ralph loop header to disable provider timeout
        if (isRalphLoop) {
          headers["x-opencode-ralph-loop"] = "true"
        }

        const fetchPromise = fetch(new URL(path, server).toString(), {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        })

        return fetchPromise.finally(() => {
          if (timeoutId) clearTimeout(timeoutId)
        })
      },
      catch: (e) => new ApiError({ message: e instanceof Error ? e.message : String(e) }),
    })

    if (!res.ok) {
      const text = yield* Effect.promise(() => res.text().catch(() => ""))
      return yield* new ApiError({
        message: `server returned HTTP ${res.status}${text ? `: ${text}` : ""}`,
        status: res.status,
      })
    }

    return yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) => new ApiError({ message: e instanceof Error ? e.message : String(e) }),
    })
  }),
)

const tool = Effect.fn("oc.tool")((name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const agent = process.env.OPENCODE_AGENT ?? "build"
    const body: ToolBody = { name, args, agent, ...(msg ? { messageID: msg } : {}) }
    return yield* api("POST", `/session/${sid}/tool`, body)
  }),
)

const stdin = Effect.fn("oc.stdin")(() =>
  Effect.gen(function* () {
    if (process.stdin.isTTY) return ""
    return yield* Effect.tryPromise({
      try: () => new Response(Bun.stdin.stream()).text(),
      catch: (e) => new ApiError({ message: e instanceof Error ? e.message : String(e) }),
    })
  }),
)

const prompt = Effect.fn("oc.prompt")((rest: string[]) =>
  Effect.gen(function* () {
    let system: string | undefined
    let model: string | undefined
    let via: string | undefined
    const files: string[] = []
    const args: string[] = []

    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "-s" || rest[i] === "--system") {
        if (i + 1 < rest.length) system = rest[++i]
        continue
      }
      if (rest[i] === "-m" || rest[i] === "--model") {
        if (i + 1 < rest.length) model = rest[++i]
        continue
      }
      if (rest[i] === "-a" || rest[i] === "--agent") {
        if (i + 1 < rest.length) via = rest[++i]
        continue
      }
      if (rest[i] === "-f" || rest[i] === "--file") {
        if (i + 1 < rest.length) files.push(rest[++i])
        continue
      }
      args.push(rest[i])
    }

    const raw = yield* stdin()
    const lines: string[] = []
    const piped: string[] = []

    if (raw) {
      for (const line of raw.split("\n")) {
        if (line.startsWith(marker)) {
          piped.push(line.substring(marker.length))
          continue
        }
        lines.push(line)
      }
    }

    const input = lines.join("\n").trim()
    const text = input ? `${input}\n\n${args.join(" ")}` : args.join(" ")

    if (!text.trim()) {
      return yield* new ValidationError({ message: "oc prompt: no prompt text provided" })
    }

    const body: ExecBody = { prompt: text }
    if (system) body.system = system
    if (via) body.agent = via
    if (msg) body.messageID = msg

    if (model) {
      const parsed = parse(model)
      if (!parsed) return yield* new ValidationError({ message: "oc prompt: model must be provider/model" })
      body.model = parsed
    }

    const paths = [...files, ...piped]
    if (paths.length > 0) {
      body.files = yield* Effect.all(
        paths.map((fp) =>
          Effect.gen(function* () {
            const safePath = sanitizePath(fp)
            const buf = yield* Effect.tryPromise({
              try: () => Bun.file(safePath).arrayBuffer(),
              catch: (e) =>
                new ApiError({ message: `Failed to read file ${fp}: ${e instanceof Error ? e.message : String(e)}` }),
            })

            // Validate file size (max 10MB)
            const maxSize = 10 * 1024 * 1024
            if (buf.byteLength > maxSize) {
              return yield* new ValidationError({
                message: `oc prompt: file ${fp} too large (${Math.round(buf.byteLength / 1024 / 1024)}MB, max 10MB)`,
              })
            }

            const base64 = Buffer.from(buf).toString("base64")
            const ext = fp.split(".").pop()?.toLowerCase() ?? ""
            const mime = mimes[ext] ?? "application/octet-stream"

            // Validate MIME type for known extensions
            const allowedTypes = [
              "application/pdf",
              "image/png",
              "image/jpeg",
              "text/plain",
              "application/octet-stream",
            ]
            if (!allowedTypes.includes(mime)) {
              return yield* new ValidationError({
                message: `oc prompt: unsupported file type ${mime} for ${fp}`,
              })
            }

            return { filename: fp.split("/").pop() ?? fp, mime, url: `data:${mime};base64,${base64}` }
          }),
        ),
      )
    }

    const label = system
      ? `prompt -s "${system.substring(0, 30)}" "${args.join(" ").substring(0, 50)}"`
      : `prompt "${args.join(" ").substring(0, 60)}"`
    log(label)

    const result = yield* api("POST", `/session/${sid}/exec`, body)
    process.stdout.write(result)
  }),
)

const check = Effect.fn("oc.check")((rest: string[]) =>
  Effect.gen(function* () {
    let model: string | undefined
    const args: string[] = []

    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "-m" || rest[i] === "--model") {
        if (i + 1 < rest.length) model = rest[++i]
        continue
      }
      args.push(rest[i])
    }

    const input = yield* stdin()
    const question = input ? `${input}\n\n${args.join(" ")}` : args.join(" ")

    if (!question.trim()) {
      return yield* new ValidationError({ message: "oc check: no question provided" })
    }

    log(`check "${question.substring(0, 60)}"`)

    const sentinel = "NO_ISSUES_FOUND"
    const body: ExecBody = {
      prompt: [
        question,
        "",
        `If you find issues, list them with file paths and line numbers.`,
        `If there are NO issues, respond with exactly: ${sentinel}`,
      ].join("\n"),
    }
    if (msg) body.messageID = msg

    if (model) {
      const parsed = parse(model)
      if (!parsed) return yield* new ValidationError({ message: "oc check: model must be provider/model" })
      body.model = parsed
    }

    const response = yield* api("POST", `/session/${sid}/exec`, body)

    const trimmed = response.trim()
    const clean = trimmed.includes(sentinel)
    if (!clean && trimmed) process.stdout.write(trimmed + "\n")
    return !clean
  }),
)

const program = Effect.gen(function* () {
  if (!server) {
    return yield* new ServerError({
      message: "OPENCODE_SERVER_URL not set — are you running inside an openCode bash tool?",
    })
  }
  if (!sid) {
    return yield* new ServerError({
      message: "OPENCODE_SESSION_ID not set — are you running inside an openCode bash tool?",
    })
  }

  const cmd = process.argv[2]
  const rest = process.argv.slice(3)

  switch (cmd) {
    case "prompt": {
      yield* prompt(rest)
      break
    }

    case "tool": {
      const name = rest[0]
      const tail = rest.slice(1)
      if (!name) {
        return yield* new ValidationError({
          message: "oc tool: no tool name. Available: read, write, edit, grep, glob, batch, bash",
        })
      }
      let args: Record<string, unknown> = {}
      switch (name) {
        case "read": {
          if (!tail[0]) {
            return yield* new ValidationError({ message: "oc tool read: file path required" })
          }
          const ni = tail.indexOf("-n")
          let limit: number | undefined
          if (ni >= 0 && ni + 1 < tail.length) {
            const parsed = parseInt(tail[ni + 1])
            limit = Number.isNaN(parsed) ? undefined : parsed
          }
          args = { filePath: sanitizePath(tail[0]), limit }
          break
        }
        case "write": {
          if (!tail[0]) {
            return yield* new ValidationError({ message: "oc tool write: file path required" })
          }
          const content = yield* stdin()
          args = { filePath: sanitizePath(tail[0]), content }
          break
        }
        case "edit": {
          if (!tail[0]) {
            return yield* new ValidationError({ message: "oc tool edit: file path required" })
          }
          let old = ""
          let rep = ""
          for (let i = 1; i < tail.length; i++) {
            if ((tail[i] === "--old" || tail[i] === "-o") && i + 1 < tail.length) {
              old = tail[++i]
              continue
            }
            if ((tail[i] === "--new" || tail[i] === "-n") && i + 1 < tail.length) {
              rep = tail[++i]
              continue
            }
          }
          args = { filePath: sanitizePath(tail[0]), oldString: old, newString: rep }
          break
        }
        case "grep":
          if (!tail[0]) {
            return yield* new ValidationError({ message: "oc tool grep: pattern required" })
          }
          const grepPath = tail[1] ?? "."
          args = { pattern: tail[0], path: sanitizePath(grepPath) }
          break
        case "glob":
          if (!tail[0]) {
            return yield* new ValidationError({ message: "oc tool glob: pattern required" })
          }
          const globPath = tail[1] ? sanitizePath(tail[1]) : undefined
          args = { pattern: tail[0], path: globPath }
          break
        case "bash": {
          const command = tail.join(" ")
          if (!command.trim()) {
            return yield* new ValidationError({ message: "oc tool bash: command required" })
          }
          // Basic command injection protection - block dangerous patterns
          const dangerous = [";", "&&", "||", "|", ">", ">>", "<", "$(", "`", "&"]
          if (dangerous.some((pattern) => command.includes(pattern))) {
            console.warn("Warning: Command contains potentially dangerous operators. Use with caution.")
          }
          args = { command: command.trim(), description: `oc bash: ${command.substring(0, 50)}` }
          break
        }
        case "batch": {
          const content = yield* stdin()
          if (!content.trim()) {
            return yield* new ValidationError({ message: "oc tool batch: no JSON content provided" })
          }
          // Limit JSON size to prevent DoS
          if (content.length > 1024 * 1024) {
            // 1MB limit
            return yield* new ValidationError({ message: "oc tool batch: JSON too large (max 1MB)" })
          }
          const parsed = yield* Effect.try({
            try: () => {
              const data = JSON.parse(content)
              // Basic structure validation
              if (!Array.isArray(data)) {
                throw new Error("Expected array of tool calls")
              }
              return data
            },
            catch: (e) =>
              new ValidationError({
                message: `oc tool batch: invalid JSON - ${e instanceof Error ? e.message : String(e)}`,
              }),
          })
          args = { tool_calls: parsed }
          break
        }
        default:
          args = Object.fromEntries(tail.map((a, i) => [i === 0 ? "input" : `arg${i}`, a]))
      }
      log(`tool ${name} ${tail[0]?.substring(0, 60) ?? ""}`)
      const result = yield* tool(name, args)
      const lines = result.split("\n")
      process.stdout.write(
        lines
          .filter((line) => {
            if (line.startsWith(trunc)) {
              process.stderr.write(`\x1b[33m[oc] ${line.substring(trunc.length)}\x1b[0m\n`)
              return false
            }
            return true
          })
          .join("\n"),
      )
      break
    }

    case "agent": {
      const type = rest[0]
      const tail = rest.slice(1)
      if (!type) {
        console.error("oc agent: usage: oc agent <type> <prompt>")
        process.exit(1)
      }
      const input = yield* stdin()
      const text = input ? `${input}\n\n${tail.join(" ")}` : tail.join(" ")
      if (!text.trim()) {
        console.error("oc agent: no prompt text")
        process.exit(1)
      }
      log(`agent ${type} "${tail.join(" ").substring(0, 50)}"`)
      const body: ExecBody = { prompt: text, agent: type }
      if (msg) body.messageID = msg
      const result = yield* api("POST", `/session/${sid}/exec`, body)
      process.stdout.write(result)
      break
    }

    case "todo": {
      const sub = rest[0]
      const tail = rest.slice(1)
      switch (sub) {
        case "add": {
          const content = tail.join(" ")
          if (!content.trim()) {
            console.error("oc todo add: no content")
            process.exit(1)
          }
          log(`todo add "${content.substring(0, 50)}"`)
          const result = yield* api("POST", `/session/${sid}/todo`, { content, status: "pending" })
          process.stdout.write(result)
          break
        }
        case "list":
        case "read": {
          const result = yield* api("GET", `/session/${sid}/todo`)
          process.stdout.write(result)
          break
        }
        case "done": {
          const idx = parseInt(tail[0])
          if (isNaN(idx) || idx < 1) {
            console.error("oc todo done: provide 1-based index")
            process.exit(1)
          }
          const response = yield* api("GET", `/session/${sid}/todo`)
          const parsed = yield* Effect.try({
            try: () => JSON.parse(response) as { content: string; status: string; priority: string }[],
            catch: () => new ValidationError({ message: "oc todo done: invalid response from server" }),
          })
          if (idx > parsed.length) {
            console.error(`oc todo done: index ${idx} out of range (max: ${parsed.length})`)
            process.exit(1)
          }
          parsed[idx - 1].status = "completed"
          log(`todo done ${idx} ✓ ${parsed[idx - 1].content.substring(0, 40)}`)
          yield* api("PUT", `/session/${sid}/todo`, { todos: parsed })
          console.log(`Marked todo ${idx} as completed: ${parsed[idx - 1].content}`)
          break
        }
        case "clear": {
          yield* api("PUT", `/session/${sid}/todo`, { todos: [] })
          console.log("Cleared all todos")
          break
        }
        default:
          console.error(`oc todo: unknown '${sub}'. Usage: oc todo <add|list|done|clear>`)
          process.exit(1)
      }
      break
    }

    case "status": {
      const message = rest.join(" ")
      if (!message.trim()) {
        console.error("oc status: no message")
        process.exit(1)
      }
      log(`status: ${message}`)
      const body: StatusBody = { message }
      if (msg) body.messageID = msg
      // Fire-and-forget: post status to server for TUI visibility, but don't fail the script
      yield* Effect.ignore(
        Effect.tryPromise({
          try: () =>
            fetch(new URL(`/session/${sid}/status`, server).toString(), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
          catch: (e) => new ApiError({ message: e instanceof Error ? e.message : String(e) }),
        }),
      )
      break
    }

    case "check": {
      const result = yield* check(rest)
      process.exit(result ? 0 : 1)
      break
    }

    case "help":
    case "--help":
    case "-h":
      console.log(`oc — openCode CLI callback tool

AI JUDGMENT (non-deterministic):
  oc prompt "question"                     AI response on stdout
  oc prompt -s "system" "question"         Dynamic specialist
  oc prompt -m provider/model "question"   Specific model
  oc prompt -f file.pdf "analyze"          Attach file (multimodal)
  cat file | oc prompt "analyze"           Context from stdin

DETERMINISTIC TOOLS:
  oc tool read <path>                      Read file → stdout
  echo "content" | oc tool write <path>    Write stdin → file
  oc tool edit <path> --old "x" --new "y"  Edit file
  oc tool grep "pattern" [path]            Search → stdout
  oc tool glob "pattern" [path]            Find files → stdout
  oc tool batch                            Execute JSON tool calls from stdin

ASSESSMENT + BOOLEAN (grep pattern — findings on stdout, boolean on exit code):
  oc check "question"                      Assessment → stdout, exit 0 (yes) / 1 (no)
  oc check -m provider/model "question"    Use specific model for assessment
  data | oc check "question"               Piped context
  while a=\$(oc check "issues?"); do        Loop pattern: capture assessment,
    echo "\$a" | oc prompt "fix"            pipe findings to fixer
  done

SUBAGENTS:
  oc agent <type> "prompt"                 Spawn subagent

STATE:
  oc todo add|list|done|clear              Manage todos
  oc status "message"                      Progress update (bold, visible in TUI)`)
      break

    default:
      console.error(`oc: unknown command '${cmd ?? ""}' — run 'oc help'`)
      process.exit(1)
  }
})

import { Exit, Cause, Option } from "effect"

Effect.runPromiseExit(program).then((exit) => {
  if (Exit.isSuccess(exit)) return
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure)) {
    const err = failure.value as { _tag?: string; message?: string }
    if (err._tag === "ValidationError" || err._tag === "ServerError" || err._tag === "ApiError") {
      console.error(err.message)
      process.exit(1)
    }
  }
  const squashed = Cause.squash(exit.cause)
  console.error(`oc: unexpected error: ${squashed instanceof Error ? squashed.message : String(squashed)}`)
  process.exit(1)
})
