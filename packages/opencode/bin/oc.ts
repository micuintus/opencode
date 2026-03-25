#!/usr/bin/env bun
// oc — micuDAC (Model Integrated Command Utility for Deterministic Agent Control)
// Calls back into the running openCode instance from bash scripts.
// Deterministic tool calls use the shell fast-path (bin/oc); this binary
// handles complex operations: prompt, agent, todo, status, and tool fallback.

const serverUrl = process.env.OPENCODE_SERVER_URL
if (!serverUrl) {
  console.error("oc: OPENCODE_SERVER_URL not set — are you running inside an openCode bash tool?")
  process.exit(1)
}
const session = process.env.OPENCODE_SESSION_ID
if (!session) {
  console.error("oc: OPENCODE_SESSION_ID not set — are you running inside an openCode bash tool?")
  process.exit(1)
}
const dir = process.env.OPENCODE_DIRECTORY ?? process.cwd()
const messageID = process.env.OPENCODE_MESSAGE_ID
const quiet = process.env.OPENCODE_QUIET === "1"

function announce(label: string) {
  if (!quiet) process.stderr.write(`\x1b[2m[oc] ${label}\x1b[0m\n`)
}

async function api(method: string, path: string, body?: any): Promise<string> {
  const url = new URL(path, serverUrl).toString()
  try {
    const res = await fetch(url, {
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

function toolBody(name: string, args: Record<string, any>): any {
  const agent = process.env.OPENCODE_AGENT ?? "build"
  const body: any = { name, args, agent }
  if (messageID) body.messageID = messageID
  return body
}

async function tool(name: string, args: Record<string, any>): Promise<string> {
  return api("POST", `/session/${session}/tool`, toolBody(name, args))
}

async function stdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  return new Response(Bun.stdin.stream()).text()
}

const OC_FILE_MARKER = "\x00OC_FILE\x00:"

const [, , cmd, ...rest] = process.argv

switch (cmd) {
  case "prompt": {
    let system: string | undefined
    let model: string | undefined
    let via: string | undefined
    const files: string[] = []
    const args: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "-s" || rest[i] === "--system") { if (i + 1 < rest.length) system = rest[++i]; continue }
      if (rest[i] === "-m" || rest[i] === "--model") { if (i + 1 < rest.length) model = rest[++i]; continue }
      if (rest[i] === "-a" || rest[i] === "--agent") { if (i + 1 < rest.length) via = rest[++i]; continue }
      if (rest[i] === "-f" || rest[i] === "--file") { if (i + 1 < rest.length) files.push(rest[++i]); continue }
      args.push(rest[i])
    }
    const rawInput = await stdin()
    // Detect OC_FILE markers from piped oc tool read output (binary file pass-through)
    const inputLines: string[] = []
    const pipedFiles: string[] = []
    if (rawInput) {
      for (const line of rawInput.split("\n")) {
        if (line.startsWith(OC_FILE_MARKER)) {
          pipedFiles.push(line.substring(OC_FILE_MARKER.length))
        } else {
          inputLines.push(line)
        }
      }
    }
    const input = inputLines.join("\n").trim()
    const text = input ? `${input}\n\n${args.join(" ")}` : args.join(" ")
    if (!text.trim()) { console.error("oc prompt: no prompt text provided"); process.exit(1) }

    const body: any = { prompt: text }
    if (system) body.system = system
    if (via) body.agent = via
    if (messageID) body.messageID = messageID
    if (model) {
      const parts = model.split("/")
      if (parts.length < 2) { console.error("oc prompt: model must be provider/model"); process.exit(1) }
      body.model = { providerID: parts[0], modelID: parts.slice(1).join("/") }
    }
    // Attach files: explicit --file + auto-detected piped binary files
    const allFiles = [...files, ...pipedFiles]
    if (allFiles.length > 0) {
      body.files = await Promise.all(allFiles.map(async (filepath) => {
        const data = await Bun.file(filepath).arrayBuffer()
        const base64 = Buffer.from(data).toString("base64")
        const ext = filepath.split(".").pop()?.toLowerCase() ?? ""
        const mime = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `application/${ext}`
        return { filename: filepath.split("/").pop() ?? filepath, mime, url: `data:${mime};base64,${base64}` }
      }))
    }

    const label = system ? `prompt -s "${system.substring(0, 30)}" "${args.join(" ").substring(0, 50)}"` : `prompt "${args.join(" ").substring(0, 60)}"`
    announce(label)
    const result = await api("POST", `/session/${session}/exec`, body)
    process.stdout.write(result)
    break
  }

  case "tool": {
    const [name, ...toolArgs] = rest
    if (!name) { console.error("oc tool: no tool name. Available: read, write, edit, grep, glob, batch, bash"); process.exit(1) }
    let args: Record<string, any> = {}
    switch (name) {
      case "read": args = { filePath: toolArgs[0], limit: toolArgs.includes("-n") ? parseInt(toolArgs[toolArgs.indexOf("-n") + 1]) : undefined }; break
      case "write": { const content = await stdin(); args = { filePath: toolArgs[0], content }; break }
      case "edit": {
        const fp = toolArgs[0]; let o = "", n = ""
        for (let i = 1; i < toolArgs.length; i++) {
          if (toolArgs[i] === "--old" || toolArgs[i] === "-o") o = toolArgs[++i]
          if (toolArgs[i] === "--new" || toolArgs[i] === "-n") n = toolArgs[++i]
        }
        args = { filePath: fp, oldString: o, newString: n }; break
      }
      case "grep": args = { pattern: toolArgs[0], path: toolArgs[1] ?? "." }; break
      case "glob": args = { pattern: toolArgs[0], path: toolArgs[1] }; break
      case "bash": { const command = toolArgs.join(" "); args = { command, description: `oc bash: ${command.substring(0, 50)}` }; break }
      case "batch": { const content = await stdin(); try { args = { tool_calls: JSON.parse(content) } } catch { console.error("oc tool batch: expects JSON from stdin"); process.exit(1) } break }
      default: args = Object.fromEntries(toolArgs.map((a, i) => [i === 0 ? "input" : `arg${i}`, a]))
    }
    announce(`tool ${name} ${toolArgs[0]?.substring(0, 60) ?? ""}`)
    const result = await tool(name, args)
    process.stdout.write(result)
    break
  }

  case "agent": {
    const [type, ...agentArgs] = rest
    if (!type) { console.error("oc agent: usage: oc agent <type> <prompt>"); process.exit(1) }
    const input = await stdin()
    const text = input ? `${input}\n\n${agentArgs.join(" ")}` : agentArgs.join(" ")
    if (!text.trim()) { console.error("oc agent: no prompt text"); process.exit(1) }
    announce(`agent ${type} "${agentArgs.join(" ").substring(0, 50)}"`)
    const body: any = { prompt: text, agent: type }
    if (messageID) body.messageID = messageID
    const result = await api("POST", `/session/${session}/exec`, body)
    process.stdout.write(result)
    break
  }

  case "todo": {
    const [sub, ...todoArgs] = rest
    switch (sub) {
      case "add": {
        const content = todoArgs.join(" ")
        if (!content.trim()) { console.error("oc todo add: no content"); process.exit(1) }
        announce(`todo add "${content.substring(0, 50)}"`)
        const result = await api("POST", `/session/${session}/todo`, { content, status: "pending" })
        process.stdout.write(result)
        break
      }
      case "list": case "read": {
        const result = await api("GET", `/session/${session}/todo`)
        process.stdout.write(result)
        break
      }
      case "done": {
        const idx = parseInt(todoArgs[0])
        if (isNaN(idx) || idx < 1) { console.error("oc todo done: provide 1-based index"); process.exit(1) }
        const todosRes = await api("GET", `/session/${session}/todo`)
        const todos = JSON.parse(todosRes)
        if (idx > todos.length) { console.error(`oc todo done: index ${idx} out of range (max: ${todos.length})`); process.exit(1) }
        todos[idx - 1].status = "completed"
        announce(`todo done ${idx} ✓ ${(todos[idx - 1].content as string).substring(0, 40)}`)
        await api("PUT", `/session/${session}/todo`, { todos })
        console.log(`Marked todo ${idx} as completed: ${todos[idx - 1].content}`)
        break
      }
      case "clear": { await api("PUT", `/session/${session}/todo`, { todos: [] }); console.log("Cleared all todos"); break }
      default: console.error(`oc todo: unknown '${sub}'. Usage: oc todo <add|list|done|clear>`); process.exit(1)
    }
    break
  }

  case "status": {
    const message = rest.join(" ")
    if (!message.trim()) { console.error("oc status: no message"); process.exit(1) }
    process.stderr.write(`\x1b[1m[oc] ${message}\x1b[0m\n`)
    break
  }

  case "help": case "--help": case "-h":
    console.log(`oc — micuDAC (Model Integrated Command Utility for Deterministic Agent Control)

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
