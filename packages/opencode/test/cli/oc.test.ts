import { describe, expect, test } from "bun:test"
import { execTimeoutOpt } from "../../bin/oc.ts"

// Regression test for: exec operations must disable Bun's native TCP timeout so that
// long-running `oc check` / `oc prompt` calls (Ralph loops, 22-commit analyses, etc.)
// are never killed mid-flight by Bun's default fetch timeout.
// See provider.ts:1324 for the same fix applied to LLM provider calls.
describe("oc.execTimeoutOpt", () => {
  test("exec path returns { timeout: false }", () => {
    expect(execTimeoutOpt("/session/abc/exec")).toEqual({ timeout: false })
    expect(execTimeoutOpt("/session/xyz_123/exec")).toEqual({ timeout: false })
  })

  test("tool path returns {}", () => {
    expect(execTimeoutOpt("/session/abc/tool")).toEqual({})
    expect(execTimeoutOpt("/session/abc/read")).toEqual({})
  })
})
