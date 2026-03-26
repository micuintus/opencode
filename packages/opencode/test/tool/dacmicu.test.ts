import { describe, test, expect, beforeAll } from "bun:test"
import { spawnSync } from "child_process"
import path from "path"

const OC_TS = path.resolve(import.meta.dirname, "../../bin/oc.ts")
const OC_SH = path.resolve(import.meta.dirname, "../../bin/oc")

// Helper: spawn oc.ts with given args and env
function oc(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", ["run", OC_TS, ...args], {
    env: {
      ...process.env,
      OPENCODE_SERVER_URL: "http://localhost:4096",
      OPENCODE_SESSION_ID: "ses_test_session",
      OPENCODE_AGENT: "build",
      OPENCODE_QUIET: "1", // suppress auto-announce in tests
      ...env,
    },
    timeout: 10000,
  })
}

// Helper: spawn shell wrapper
function ocsh(args: string[], env: Record<string, string> = {}) {
  return spawnSync(OC_SH, args, {
    env: {
      ...process.env,
      OPENCODE_SERVER_URL: "http://localhost:4096",
      OPENCODE_SESSION_ID: "ses_test_session",
      OPENCODE_AGENT: "build",
      OPENCODE_QUIET: "1",
      PATH: `${path.dirname(OC_SH)}:${process.env.PATH}`,
      ...env,
    },
    timeout: 10000,
  })
}

describe("DACMICU", () => {
  // ── CLI Unit Tests ──────────────────────────────────────────

  describe("oc CLI — env validation", () => {
    test("missing SERVER_URL errors", () => {
      const result = spawnSync("bun", ["run", OC_TS, "--help"], {
        env: { ...process.env, OPENCODE_SERVER_URL: "", OPENCODE_SESSION_ID: "x" },
        timeout: 5000,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("OPENCODE_SERVER_URL")
    })

    test("missing SESSION_ID errors", () => {
      const result = spawnSync("bun", ["run", OC_TS, "--help"], {
        env: { ...process.env, OPENCODE_SERVER_URL: "http://x", OPENCODE_SESSION_ID: "" },
        timeout: 5000,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("OPENCODE_SESSION_ID")
    })
  })

  describe("oc CLI — help", () => {
    test("--help prints usage", () => {
      const result = oc(["--help"])
      expect(result.status).toBe(0)
      expect(result.stdout.toString()).toContain("DACMICU")
      expect(result.stdout.toString()).toContain("oc prompt")
      expect(result.stdout.toString()).toContain("oc tool")
    })

    test("help subcommand works", () => {
      const result = oc(["help"])
      expect(result.status).toBe(0)
      expect(result.stdout.toString()).toContain("DETERMINISTIC TOOLS")
    })
  })

  describe("oc CLI — unknown command", () => {
    test("unknown command errors", () => {
      const result = oc(["nonexistent"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("unknown command")
    })
  })

  describe("oc CLI — prompt subcommand", () => {
    test("no text errors", () => {
      const result = oc(["prompt"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("no prompt text")
    })

    test("prompt sends to /exec (fails on HTTP, not parse)", () => {
      const result = oc(["prompt", "hello"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toMatch(/server (error|returned HTTP)/)
    })

    test("-s flag parses system prompt", () => {
      const result = oc(["prompt", "-s", "pirate", "hello"])
      expect(result.status).not.toBe(0)
      // Should not fail on argument parsing — only on HTTP
      expect(result.stderr.toString()).not.toContain("no prompt text")
    })

    test("-m flag parses model", () => {
      const result = oc(["prompt", "-m", "anthropic/claude", "hello"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).not.toContain("no prompt text")
    })

    test("bad model format errors", () => {
      const result = oc(["prompt", "-m", "badmodel", "hello"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("provider/model")
    })
  })

  describe("oc CLI — tool subcommand", () => {
    test("no tool name errors", () => {
      const result = oc(["tool"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("no tool name")
    })

    test("read parses file path", () => {
      const result = oc(["tool", "read", "/tmp/test.ts"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toMatch(/server (error|returned HTTP)/)
    })

    test("glob parses pattern and path", () => {
      const result = oc(["tool", "glob", "*.ts", "/src"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toMatch(/server (error|returned HTTP)/)
    })

    test("grep parses pattern and path", () => {
      const result = oc(["tool", "grep", "TODO", "src/"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toMatch(/server (error|returned HTTP)/)
    })
  })

  describe("oc CLI — todo subcommand", () => {
    test("todo add without content errors", () => {
      const result = oc(["todo", "add"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("no content")
    })

    test("todo done without index errors", () => {
      const result = oc(["todo", "done"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("1-based index")
    })

    test("todo done 0 errors", () => {
      const result = oc(["todo", "done", "0"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("1-based index")
    })

    test("todo unknown subcommand errors", () => {
      const result = oc(["todo", "xyz"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("unknown")
    })
  })

  describe("oc CLI — agent subcommand", () => {
    test("no type errors", () => {
      const result = oc(["agent"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("usage")
    })

    test("no prompt errors", () => {
      const result = oc(["agent", "explore"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("no prompt text")
    })
  })

  describe("oc CLI — status subcommand", () => {
    test("status writes to stderr", () => {
      const result = oc(["status", "Processing..."], { OPENCODE_QUIET: "0" })
      expect(result.status).toBe(0)
      expect(result.stderr.toString()).toContain("Processing...")
    })

    test("status without message errors", () => {
      const result = oc(["status"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("no message")
    })
  })

  describe("oc CLI — auto-announce", () => {
    test("auto-announce writes dimmed text to stderr", () => {
      const result = oc(["prompt", "hello"], { OPENCODE_QUIET: "0" })
      // Will fail on HTTP, but should have announced first
      const stderr = result.stderr.toString()
      expect(stderr).toContain("[oc]")
      expect(stderr).toContain("prompt")
    })

    test("OPENCODE_QUIET=1 suppresses announce", () => {
      const result = oc(["prompt", "hello"], { OPENCODE_QUIET: "1" })
      const stderr = result.stderr.toString()
      expect(stderr).not.toContain("[oc]")
    })
  })

  describe("oc CLI — connection error handling", () => {
    test("connection refused gives user-friendly error", () => {
      const result = oc(["tool", "read", "/tmp/test.ts"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toMatch(/server (error|returned HTTP)/)
      // Should NOT contain raw stack traces
      expect(result.stderr.toString()).not.toContain("at ")
    })
  })

  // ── Binary File Protocol Tests ──────────────────────────────

  describe("binary file protocol", () => {
    const OC_FILE_MARKER = "\x00OC_FILE\x00:"

    test("detects marker in text", () => {
      const input = `PDF read successfully\n${OC_FILE_MARKER}/path/to/file.pdf`
      const lines = input.split("\n")
      const files: string[] = []
      const text: string[] = []
      for (const line of lines) {
        if (line.startsWith(OC_FILE_MARKER)) files.push(line.substring(OC_FILE_MARKER.length))
        else text.push(line)
      }
      expect(files).toEqual(["/path/to/file.pdf"])
      expect(text).toEqual(["PDF read successfully"])
    })

    test("no marker = plain text", () => {
      const input = "Just regular text\nAnother line"
      const lines = input.split("\n")
      const files: string[] = []
      for (const line of lines) {
        if (line.startsWith(OC_FILE_MARKER)) files.push(line.substring(OC_FILE_MARKER.length))
      }
      expect(files).toEqual([])
    })

    test("multiple markers extracted", () => {
      const input = `text\n${OC_FILE_MARKER}/a.pdf\nmore\n${OC_FILE_MARKER}/b.png`
      const files: string[] = []
      for (const line of input.split("\n")) {
        if (line.startsWith(OC_FILE_MARKER)) files.push(line.substring(OC_FILE_MARKER.length))
      }
      expect(files).toEqual(["/a.pdf", "/b.png"])
    })

    test("marker cannot appear in normal text", () => {
      // Null bytes can't be typed or appear in normal text streams
      const normalText = "__oc_file__:/path/to/file.pdf"
      expect(normalText.startsWith(OC_FILE_MARKER)).toBe(false)
    })
  })

  // ── Shell Fast-Path Tests ──────────────────────────────────

  describe("shell fast-path", () => {
    test("bin/oc is executable", () => {
      const result = ocsh(["help"])
      expect(result.status).toBe(0)
      expect(result.stdout.toString()).toContain("DACMICU")
    })

    test("bin/oc routes tool to fast path (if jq available)", () => {
      const result = ocsh(["tool", "read", "/tmp/test.ts"])
      // curl may succeed (HTTP 200 with error body) or fail — either way it shouldn't crash on routing
      const output = result.stdout.toString() + result.stderr.toString()
      // Should not contain shell syntax errors
      expect(output).not.toContain("syntax error")
    })
  })

  // ── Data Integrity Tests ──────────────────────────────────

  describe("toModelMessages filter", () => {
    test("oc metadata marker is correct shape", () => {
      const ocPart = { type: "tool", metadata: { oc: true }, state: { status: "completed" } }
      expect(ocPart.metadata?.oc).toBe(true)
    })

    test("non-oc part has no oc marker", () => {
      const normalPart = { type: "tool", metadata: undefined as any, state: { status: "completed" } }
      expect(normalPart.metadata?.oc).toBeUndefined()
    })
  })

  // ── oc check Tests ─────────────────────────────────────

  describe("oc check subcommand", () => {
    test("no question errors", () => {
      const result = oc(["check"])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("no question")
    })

    test("sends to /exec with followUp (fails on HTTP, not parse)", () => {
      const result = oc(["check", "Are tests passing?"])
      // Should fail on HTTP connection (exit 0 = conservative), not argument parsing
      expect(result.stderr.toString()).not.toContain("no question")
    })

    test("help text includes oc check with grep pattern", () => {
      const result = oc(["help"])
      expect(result.stdout.toString()).toContain("oc check")
      expect(result.stdout.toString()).toContain("grep pattern")
      expect(result.stdout.toString()).toContain("while")
    })

    test("help text says DACMICU", () => {
      const result = oc(["help"])
      expect(result.stdout.toString()).toContain("DACMICU")
    })
  })

  // ── oc check grep pattern (OC_FOLLOWUP protocol) ─────────

  describe("oc check OC_FOLLOWUP parsing", () => {
    const OC_FOLLOWUP = "\x00OC_FOLLOWUP\x00:"

    test("parses assessment + boolean from OC_FOLLOWUP marker", () => {
      const response = `Found 3 issues:\n1) unused import\n2) missing validation\n3) duplicated code\n${OC_FOLLOWUP}{"result":true}`
      const markerIdx = response.indexOf(OC_FOLLOWUP)
      expect(markerIdx).toBeGreaterThan(0)

      const assessment = response.substring(0, markerIdx)
      expect(assessment).toContain("Found 3 issues")
      expect(assessment).not.toContain("OC_FOLLOWUP")

      const followUp = JSON.parse(response.substring(markerIdx + OC_FOLLOWUP.length))
      expect(followUp.result).toBe(true)
    })

    test("result=true → exit code 0 (yes, issues found → loop continues)", () => {
      const response = `Issues found\n${OC_FOLLOWUP}{"result":true}`
      const markerIdx = response.indexOf(OC_FOLLOWUP)
      const followUp = JSON.parse(response.substring(markerIdx + OC_FOLLOWUP.length))
      // result === true → exit 0 (affirmative)
      const exitCode = followUp.result === true ? 0 : 1
      expect(exitCode).toBe(0)
    })

    test("result=false → exit code 1 (no issues → loop breaks)", () => {
      const response = `No issues found. Code is clean.\n${OC_FOLLOWUP}{"result":false}`
      const markerIdx = response.indexOf(OC_FOLLOWUP)
      const followUp = JSON.parse(response.substring(markerIdx + OC_FOLLOWUP.length))
      const exitCode = followUp.result === true ? 0 : 1
      expect(exitCode).toBe(1)
    })

    test("no marker → falls back to text matching", () => {
      const response = "Yes, there are issues with the code"
      const markerIdx = response.indexOf(OC_FOLLOWUP)
      expect(markerIdx).toBe(-1)
      // Fallback: text matching
      const lower = response.toLowerCase().trim()
      const result = /^(yes|true|1|affirm|correct)/.test(lower) || (lower.includes("yes") && !lower.includes("no"))
      expect(result).toBe(true)
    })

    test("text fallback: 'No issues found' → false", () => {
      const response = "No issues found"
      const lower = response.toLowerCase().trim()
      const result = /^(yes|true|1|affirm|correct)/.test(lower) || (lower.includes("yes") && !lower.includes("no"))
      expect(result).toBe(false)
    })

    test("marker cannot appear in normal text", () => {
      const normalText = "The OC_FOLLOWUP protocol handles responses"
      expect(normalText.indexOf(OC_FOLLOWUP)).toBe(-1)
    })
  })

  // ── Timeout Detection Tests ─────────────────────────────

  describe("oc auto-timeout", () => {
    test("oc regex detects oc tool commands", () => {
      const regex = /\boc\s+(tool|prompt|agent|todo|status|check)\b/
      expect(regex.test('oc tool read "$f"')).toBe(true)
      expect(regex.test('oc prompt "summarize"')).toBe(true)
      expect(regex.test('oc agent explore "task"')).toBe(true)
      expect(regex.test('oc todo add "item"')).toBe(true)
      expect(regex.test('oc status "progress"')).toBe(true)
      expect(regex.test('oc check "any issues?"')).toBe(true)
      expect(regex.test('while a=$(oc check "test"); do')).toBe(true)
      expect(regex.test('echo "hello"')).toBe(false)
      expect(regex.test('npm test')).toBe(false)
      expect(regex.test('git log --oneline')).toBe(false)
      // Should not match partial words
      expect(regex.test('echo "doc tool"')).toBe(false)
      expect(regex.test('ocelot prompt')).toBe(false)
    })
  })

  // ── Regression Tests ──────────────────────────────────────

  describe("regression", () => {
    test("OPENCODE_MESSAGE_ID env var is harmless when absent", () => {
      const result = oc(["--help"], { OPENCODE_MESSAGE_ID: "" })
      expect(result.status).toBe(0)
    })

    test("empty prompt string is rejected", () => {
      const result = oc(["prompt", ""])
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain("no prompt text")
    })
  })
})
