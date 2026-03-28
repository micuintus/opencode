import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Todo } from "../../src/session/todo"
import { Log } from "../../src/util/log"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

// Helper: create a session with user+assistant messages (simulates bash tool context)
async function createSessionWithMessage(sessionID: SessionID) {
  // Create user message first (assistant needs parentID)
  const userID = MessageID.ascending()
  await Session.updateMessage({
    id: userID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)

  const assistantID = MessageID.ascending()
  await Session.updateMessage({
    id: assistantID,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: userID,
    agent: "build",
    modelID: "test-model",
    providerID: "test",
    mode: "",
    path: { cwd: root, root },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Info)
  return assistantID
}

describe("oc — /session/:id/tool endpoint", () => {
  test("executes a tool and returns output", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/tool`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "glob", args: { pattern: "*.ts" } }),
        })
        expect(res.status).toBe(200)
        const text = await res.text()
        // Should return some .ts files from the project root
        expect(text.length).toBeGreaterThan(0)

        await Session.remove(session.id)
      },
    })
  })

  test("returns 404 for unknown tool", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/tool`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "nonexistent_tool_xyz", args: {} }),
        })
        expect(res.status).toBe(404)

        await Session.remove(session.id)
      },
    })
  })

  test("creates ToolPart when messageID provided", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const msgID = await createSessionWithMessage(session.id)
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/tool`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "glob",
            args: { pattern: "package.json" },
            messageID: msgID,
          }),
        })
        expect(res.status).toBe(200)
        await res.text() // consume stream — ToolPart update happens inside

        // Check that a ToolPart was created on the message
        const parts = await MessageV2.parts(msgID)
        const ocParts = parts.filter((p: any) => p.type === "tool" && p.metadata?.oc === true) as any[]
        expect(ocParts.length).toBe(1)
        expect(ocParts[0].tool).toBe("glob")
        expect(ocParts[0].state.status).toBe("completed")

        await Session.remove(session.id)
      },
    })
  })

  test("does NOT create ToolPart without messageID", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const msgID = await createSessionWithMessage(session.id)
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/tool`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "glob", args: { pattern: "package.json" } }),
        })
        expect(res.status).toBe(200)

        // No oc ToolParts should be created
        const parts = await MessageV2.parts(msgID)
        const ocParts = parts.filter((p: any) => p.type === "tool" && p.metadata?.oc === true) as any[]
        expect(ocParts.length).toBe(0)

        await Session.remove(session.id)
      },
    })
  })

  // Note: tool error tests skipped because tools ask for permissions which
  // hang in test context. Error handling is tested via CLI tests in dacmicu.test.ts.

  test("binary file pass-through appends OC_FILE marker for PDF", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        // Create a small test PDF-like file
        const file = path.join(root, "test/tool/fixtures/test.pdf")
        await Bun.write(file, "%PDF-1.4 test content")

        const res = await app.request(`/session/${session.id}/tool`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "read",
            args: { filePath: file },
          }),
        })
        expect(res.status).toBe(200)
        const text = await res.text()
        // PDF files return "PDF read successfully" + OC_FILE marker
        expect(text).toContain("PDF read successfully")
        expect(text).toContain("\x00OC_FILE\x00:")
        expect(text).toContain(file)

        // Cleanup
        await fs.unlink(file)
        await Session.remove(session.id)
      },
    })
  })
})

describe("oc — exec followUp schema", () => {
  test("exec endpoint accepts followUp field in request body", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        // The exec endpoint should accept the followUp field without validation error.
        // It will fail on the actual prompt (no model configured), but the schema should accept it.
        const res = await app.request(`/session/${session.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "test",
            followUp: {
              prompt: "Is the answer yes?",
              format: {
                type: "json_schema",
                schema: {
                  type: "object",
                  properties: { result: { type: "boolean" } },
                  required: ["result"],
                },
              },
            },
          }),
        })
        // Should NOT be 400 (validation error) — the schema accepts followUp
        expect(res.status).not.toBe(400)

        await Session.remove(session.id)
      },
    })
  })

  test("exec endpoint rejects invalid followUp shape", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "test",
            followUp: { invalid: true }, // missing prompt and format
          }),
        })
        expect(res.status).toBe(400)

        await Session.remove(session.id)
      },
    })
  })
})

describe("oc — todo endpoints", () => {
  test("POST creates a todo", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        const res = await app.request(`/session/${session.id}/todo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Test task", status: "pending" }),
        })
        expect(res.status).toBe(200)
        const todo = await res.json()
        expect(todo.content).toBe("Test task")
        expect(todo.status).toBe("pending")
        expect(todo.priority).toBe("medium")

        // Verify it's in the list
        const todos = Todo.get(session.id)
        expect(todos.length).toBe(1)

        await Session.remove(session.id)
      },
    })
  })

  test("PUT replaces all todos", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default()

        // Add 2 todos
        Todo.update({ sessionID: session.id, todos: [{ content: "Task 1", status: "pending", priority: "medium" }] })
        Todo.update({
          sessionID: session.id,
          todos: [...Todo.get(session.id), { content: "Task 2", status: "pending", priority: "medium" }],
        })
        expect(Todo.get(session.id).length).toBe(2)

        // Replace with 1 todo
        const res = await app.request(`/session/${session.id}/todo`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ todos: [{ content: "Replaced", status: "completed", priority: "high" }] }),
        })
        expect(res.status).toBe(200)
        const todos = Todo.get(session.id)
        expect(todos.length).toBe(1)
        expect(todos[0].content).toBe("Replaced")
        expect(todos[0].status).toBe("completed")

        await Session.remove(session.id)
      },
    })
  })

  test("Todo.update supports incremental additions", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})

        // Add 10 todos incrementally
        for (let i = 0; i < 10; i++) {
          const existing = Todo.get(session.id)
          Todo.update({
            sessionID: session.id,
            todos: [...existing, { content: `Task ${i}`, status: "pending", priority: "medium" }],
          })
        }

        const todos = Todo.get(session.id)
        expect(todos.length).toBe(10)
        // Verify ordering is preserved
        expect(todos[0].content).toBe("Task 0")
        expect(todos[9].content).toBe("Task 9")

        await Session.remove(session.id)
      },
    })
  })
})
