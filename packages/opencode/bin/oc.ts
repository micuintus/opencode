#!/usr/bin/env bun
// oc — DACMICU (Deterministic Agent Control by Model Instructed Command Umbrella)
// Calls back into the running openCode instance from bash scripts.
// Deterministic tool calls use the shell fast-path (bin/oc); this binary
// handles complex operations: prompt, agent, todo, status, and tool fallback.

const server = process.env.OPENCODE_SERVER_URL
if (!server) {
  console.error("oc: OPENCODE_SERVER_URL not set — are you running inside an openCode bash tool?")
  process.exit(1)
}
const session = process.env.OPENCODE_SESSION_ID
if (!session) {
  console.error("oc: OPENCODE_SESSION_ID not set — are you running inside an openCode bash tool?")
  process.exit(1)
}
const dir = process.env.OPENCODE_DIRECTORY ?? process.cwd()
const msg = process.env.OPENCODE_MESSAGE_ID
const quiet = process.env.OPENCODE_QUIET === "1"

// Type definitions
interface ApiRequestBody {
  [key: string]: string | number | boolean | object | undefined
}

interface ToolArgs {
  [key: string]: string | number | boolean | object | undefined
}

interface ToolCallBody extends ApiRequestBody {
  name: string
  args: ToolArgs
  agent: string
  messageID?: string
}

function announce(label: string) {
  if (!quiet) process.stderr.write(`\x1b[2m[oc] ${label}\x1b[0m\n`)
}

async function api(method: string, path: string, body?: ApiRequestBody): Promise<string> {
  try {
    const res = await fetch(new URL(path, server).toString(), {
      method,
      headers: { "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(dir) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`oc: server returned HTTP ${res.status}`)
      if (text) console.error(text)
      process.exit(1)
    }
    return res.text()
  } catch (err) {
    console.error(`oc: server error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

function toolBody(name: string, args: ToolArgs): ToolCallBody {
  const agent = process.env.OPENCODE_AGENT ?? "build"
  const body: ToolCallBody = { name, args, agent }
  if (msg) body.messageID = msg
  return body
}

async function tool(name: string, args: ToolArgs): Promise<string> {
  return api("POST", `/session/${session}/tool`, toolBody(name, args))
}

async function stdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  return new Response(Bun.stdin.stream()).text()
}

async function handlePrompt(rest: string[]): Promise<void> {
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
  const raw = await stdin()
  // Detect OC_FILE markers from piped oc tool read output (binary file pass-through)
  const lines: string[] = []
  const piped: string[] = []
  if (raw) {
    for (const line of raw.split("\n")) {
      if (line.startsWith(OC_FILE_MARKER)) {
        piped.push(line.substring(OC_FILE_MARKER.length))
      } else {
        lines.push(line)
      }
    }
  }
  const input = lines.join("\n").trim()
  const text = input ? `${input}\n\n${args.join(" ")}` : args.join(" ")
  if (!text.trim()) {
    console.error("oc prompt: no prompt text provided")
    process.exit(1)
  }

  const body: ApiRequestBody = { prompt: text }
  if (system) body.system = system
  if (via) body.agent = via
  if (msg) body.messageID = msg
  if (model) {
    const parts = model.split("/")
    if (parts.length < 2) {
      console.error("oc prompt: model must be provider/model")
      process.exit(1)
    }
    body.model = { providerID: parts[0], modelID: parts.slice(1).join("/") }
  }
  // Attach files: explicit --file + auto-detected piped binary files
  const attached = [...files, ...piped]
  if (attached.length > 0) {
    body.files = await Promise.all(
      attached.map(async (filepath: string) => {
        const base64 = Buffer.from(await Bun.file(filepath).arrayBuffer()).toString("base64")
        const ext = filepath.split(".").pop()?.toLowerCase() ?? ""
        const mime =
          ext === "pdf"
            ? "application/pdf"
            : ext === "png"
              ? "image/png"
              : ext === "jpg" || ext === "jpeg"
                ? "image/jpeg"
                : `application/${ext}`
        return { filename: filepath.split("/").pop() ?? filepath, mime, url: `data:${mime};base64,${base64}` }
      }),
    )
  }

  const label = system
    ? `prompt -s "${system.substring(0, 30)}" "${args.join(" ").substring(0, 50)}"`
    : `prompt "${args.join(" ").substring(0, 60)}"`
  announce(label)
  const result = await api("POST", `/session/${session}/exec`, body)
  process.stdout.write(result)
}

async function handleCheck(rest: string[]): Promise<void> {
  // grep pattern: detailed assessment on stdout, boolean on exit code.
  // The agent investigates with full tool access (no json_schema constraint),
  // then a same-session follow-up gets the boolean (warm KV cache, ~40 tokens).
  //
  // Usage in while-capture pattern:
  //   while assessment=$(oc check "issues?"); do echo "$assessment" | oc prompt "fix"; done
  const input = await stdin()
  const question = input ? `${input}\n\n${rest.join(" ")}` : rest.join(" ")
  if (!question.trim()) {
    console.error("oc check: no question provided")
    process.exit(1)
  }
  announce(`check "${question.substring(0, 60)}"`)

  const BOOL_SCHEMA = {
    type: "object",
    properties: {
      result: {
        type: "boolean",
        description: "true if the answer to the original question is yes/affirmative, false otherwise",
      },
    },
    required: ["result"],
  }

  const body: ApiRequestBody = {
    // Frame as a bounded task — "report your findings" implies do it once and return.
    prompt: `Complete the following assessment and report your findings:\n\n${question}`,
    // No format constraint — agent can use tools for full assessment.
    followUp: {
      prompt:
        "Did your assessment find issues, problems, or items that need attention? Answer true if you found issues, false if everything is clean. Answer only with the structured output.",
      format: { type: "json_schema", schema: BOOL_SCHEMA },
    },
  }
  if (msg) body.messageID = msg

  const OC_FOLLOWUP = "\x00OC_FOLLOWUP\x00:"

  try {
    const response = await api("POST", `/session/${session}/exec`, body)

    // Parse response: assessment text + follow-up boolean
    const marker = response.indexOf(OC_FOLLOWUP)
    let assessment: string
    let result: boolean

    if (marker !== -1) {
      // Server returned follow-up: assessment + boolean
      assessment = response.substring(0, marker)
      try {
        const parsed = JSON.parse(response.substring(marker + OC_FOLLOWUP.length))
        result = parsed.result === true
      } catch {
        result = true // parse failed → conservative: assume yes, keep loop going
      }
    } else {
      // No follow-up marker — fallback to text matching on response
      assessment = response
      const lower = response.toLowerCase().trim()
      result = /^(yes|true|1|affirm|correct)/.test(lower) || (lower.includes("yes") && !lower.includes("no"))
    }

    // grep pattern: findings to stdout, boolean to exit code
    if (assessment.trim()) process.stdout.write(assessment.trimEnd() + "\n")
    process.exit(result === true ? 0 : 1)
  } catch (e) {
    // HTTP/network error — exit 0 = conservative = keeps the loop going
    console.error(`[oc] check error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(0)
  }
}

const OC_FILE_MARKER = "\x00OC_FILE\x00:"
const OC_TRUNCATED_MARKER = "\x00OC_TRUNCATED\x00:"

const [, , cmd, ...rest] = process.argv

switch (cmd) {
  case "prompt": {
    await handlePrompt(rest)
    break
  }

  case "tool": {
    const [name, ...toolArgs] = rest
    if (!name) {
      console.error("oc tool: no tool name. Available: read, write, edit, grep, glob, batch, bash")
      process.exit(1)
    }
    let args: ToolArgs = {}
    switch (name) {
      case "read":
        args = {
          filePath: toolArgs[0],
          limit: toolArgs.includes("-n") ? parseInt(toolArgs[toolArgs.indexOf("-n") + 1]) : undefined,
        }
        break
      case "write": {
        const content = await stdin()
        args = { filePath: toolArgs[0], content }
        break
      }
      case "edit": {
        const fp = toolArgs[0]
        const params = { old: "", new: "" }
        for (let i = 1; i < toolArgs.length; i++) {
          if ((toolArgs[i] === "--old" || toolArgs[i] === "-o") && i + 1 < toolArgs.length) params.old = toolArgs[++i]
          if ((toolArgs[i] === "--new" || toolArgs[i] === "-n") && i + 1 < toolArgs.length) params.new = toolArgs[++i]
        }
        args = { filePath: fp, oldString: params.old, newString: params.new }
        break
      }
      case "grep":
        args = { pattern: toolArgs[0], path: toolArgs[1] ?? "." }
        break
      case "glob":
        args = { pattern: toolArgs[0], path: toolArgs[1] }
        break
      case "bash": {
        const command = toolArgs.join(" ")
        args = { command, description: `oc bash: ${command.substring(0, 50)}` }
        break
      }
      case "batch": {
        const content = await stdin()
        try {
          args = { tool_calls: JSON.parse(content) }
        } catch {
          console.error("oc tool batch: expects JSON from stdin")
          process.exit(1)
        }
        break
      }
      default:
        args = Object.fromEntries(toolArgs.map((a, i) => [i === 0 ? "input" : `arg${i}`, a]))
    }
    announce(`tool ${name} ${toolArgs[0]?.substring(0, 60) ?? ""}`)
    const result = await tool(name, args)
    // Filter out in-band metadata (null-byte protocol) — redirect to stderr
    const lines = result.split("\n")
    const output: string[] = []
    for (const line of lines) {
      if (line.startsWith(OC_TRUNCATED_MARKER)) {
        process.stderr.write(`\x1b[33m[oc] ${line.substring(OC_TRUNCATED_MARKER.length)}\x1b[0m\n`)
      } else {
        output.push(line)
      }
    }
    process.stdout.write(output.join("\n"))
    break
  }

  case "agent": {
    const [type, ...agentArgs] = rest
    if (!type) {
      console.error("oc agent: usage: oc agent <type> <prompt>")
      process.exit(1)
    }
    const input = await stdin()
    const text = input ? `${input}\n\n${agentArgs.join(" ")}` : agentArgs.join(" ")
    if (!text.trim()) {
      console.error("oc agent: no prompt text")
      process.exit(1)
    }
    announce(`agent ${type} "${agentArgs.join(" ").substring(0, 50)}"`)
    const body: ApiRequestBody = { prompt: text, agent: type }
    if (msg) body.messageID = msg
    const result = await api("POST", `/session/${session}/exec`, body)
    process.stdout.write(result)
    break
  }

  case "todo": {
    const [sub, ...todoArgs] = rest
    switch (sub) {
      case "add": {
        const content = todoArgs.join(" ")
        if (!content.trim()) {
          console.error("oc todo add: no content")
          process.exit(1)
        }
        announce(`todo add "${content.substring(0, 50)}"`)
        const result = await api("POST", `/session/${session}/todo`, { content, status: "pending" })
        process.stdout.write(result)
        break
      }
      case "list":
      case "read": {
        const result = await api("GET", `/session/${session}/todo`)
        process.stdout.write(result)
        break
      }
      case "done": {
        const idx = parseInt(todoArgs[0])
        if (isNaN(idx) || idx < 1) {
          console.error("oc todo done: provide 1-based index")
          process.exit(1)
        }
        const response = await api("GET", `/session/${session}/todo`)
        const todos = JSON.parse(response)
        if (idx > todos.length) {
          console.error(`oc todo done: index ${idx} out of range (max: ${todos.length})`)
          process.exit(1)
        }
        todos[idx - 1].status = "completed"
        announce(`todo done ${idx} ✓ ${(todos[idx - 1].content as string).substring(0, 40)}`)
        await api("PUT", `/session/${session}/todo`, { todos })
        console.log(`Marked todo ${idx} as completed: ${todos[idx - 1].content}`)
        break
      }
      case "clear": {
        await api("PUT", `/session/${session}/todo`, { todos: [] })
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
    announce(`status: ${message}`)
    // Fire-and-forget: post status to server for TUI visibility, but don't fail the script
    const body: ApiRequestBody = { message }
    if (msg) body.messageID = msg
    fetch(new URL(`/session/${session}/status`, server).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {})
    break
  }

  case "check": {
    await handleCheck(rest)
    break
  }

  case "help":
  case "--help":
  case "-h":
    console.log(`oc — DACMICU (Deterministic Agent Control by Model Instructed Command Umbrella)

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
  data | oc check "question"               Piped context
  while a=$(oc check "issues?"); do        Loop pattern: capture assessment,
    echo "$a" | oc prompt "fix"            pipe findings to fixer
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
