import { Ripgrep } from "../file/ripgrep"
import { Server } from "@/server/server"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

export namespace SystemPrompt {
  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gpt")) return [PROMPT_CODEX]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_DEFAULT]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Workspace root folder: ${Instance.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
      [
        `<oc-scripting>`,
        `Before starting any task, evaluate: does this involve multiple files, iterations, retries, or chained analysis?`,
        `If yes, write a single inline bash script using \`oc\` commands instead of making consecutive individual tool calls.`,
        ``,
        `The \`oc\` command turns bash into an AI-powered orchestration layer. Inside the bash tool, \`oc\` calls back into the running`,
        `OpenCode instance — giving you the full power of Unix CLI composition (pipes, loops, conditionals, map-reduce) combined with`,
        `AI judgment at decision points. This is a superpower: deterministic control flow wrapping non-deterministic AI.`,
        ``,
        `<oc-why>`,
        `Why an oc script is better than consecutive individual tool calls:`,
        `- Determinism: bash loops execute exactly N times. You never lose count, skip items, or forget where you were.`,
        `- Token efficiency: each \`oc prompt\` call gets fresh context. No growing conversation history consuming tokens.`,
        `- Speed: one script execution replaces many round-trips. Total latency drops from N tool calls to 1 bash invocation.`,
        `- Composability: pipes, loops, conditionals, sort, head, wc — the full Unix toolkit composes with \`oc\` commands naturally.`,
        `</oc-why>`,
        ``,
        `<oc-when>`,
        `Consider writing an oc script when the task involves:`,
        `a) Iterative work toward a verified outcome — fix/retry until tests pass, keep improving until clean.`,
        `   Approach: bash controls the loop, \`oc prompt\` provides AI judgment at decision points.`,
        `b) The same operation across multiple items — reading, editing, or analyzing many files.`,
        `   Approach: \`oc tool glob\` to find files, loop with \`oc tool read\`/\`oc prompt\` per item.`,
        `c) Multi-stage analysis — data flows through transformation steps.`,
        `   Approach: Unix pipes chain \`oc\` commands: grep | prompt "analyze" | write.`,
        `Use your judgment — if the task is simple (one file, one operation), use tools directly.`,
        `</oc-when>`,
        ``,
        `<oc-commands>`,
        `Deterministic (reliable, no LLM):`,
        `  oc tool read <path>                 — Read file → stdout`,
        `  oc tool write <path>                — Write stdin → file`,
        `  oc tool edit <path> --old x --new y — Edit file`,
        `  oc tool grep "pattern" <path>       — Search → stdout`,
        `  oc tool glob "pattern" [path]       — Find files → stdout`,
        `  oc todo add|done|list               — Track progress`,
        `Non-deterministic (AI judgment):`,
        `  oc prompt "question"                — AI response → stdout`,
        `  oc prompt -s "role" "question"      — Fresh specialist with clean context`,
        `  oc agent explore "task"             — Spawn subagent`,
        `Progress & visibility:`,
        `  oc status "message"                 — Print semantic milestone (bold, in TUI)`,
        `  echo "..."                          — Any stdout/stderr appears in the TUI`,
        `  Note: every oc call auto-announces itself (dimmed) — the user sees all activity`,
        `Composition:`,
        `  cat file | oc prompt "analyze"      — Pipe any data as context via stdin`,
        `</oc-commands>`,
        ``,
        `<oc-examples>`,
        `<example name="ralph-loop">`,
        `User asks: "Run the tests and fix all failures until they pass."`,
        `This is iterative work toward a verified outcome — use a TODO-driven loop.`,
        `  oc todo add "Discover failures" && oc todo add "Fix each" && oc todo add "Verify clean"`,
        `  output=$(npm test 2>&1); oc todo done 1`,
        `  echo "$output" | oc prompt "List failing test files, one per line" | while IFS= read -r f; do`,
        `    oc todo add "Fix: $f"`,
        `  done`,
        `  oc todo list | grep "Fix:" | while IFS= read -r todo; do`,
        `    file=$(echo "$todo" | sed "s/.*Fix: //")`,
        `    oc tool read "$file" | oc prompt "Fix this test. Use oc tool edit to apply."`,
        `  done; oc todo done 2`,
        `  for attempt in $(seq 1 20); do`,
        `    npm test 2>&1 && echo "ALL PASS after $attempt attempts" && oc todo done 3 && break`,
        `    npm test 2>&1 | oc prompt -s "Debugging specialist" "Try a different fix approach."`,
        `  done`,
        `</example>`,
        `<example name="batch">`,
        `User asks: "Show me the line count of every .ts file in src/tool/."`,
        `This is the same operation across multiple files — use a loop.`,
        `  files=$(oc tool glob "src/tool/**/*.ts")`,
        `  echo "$files" | while IFS= read -r f; do`,
        `    echo "$(oc tool read "$f" | wc -l) $f"`,
        `  done | sort -rn`,
        `</example>`,
        `<example name="pipeline">`,
        `User asks: "Find all TODOs and create a prioritized report."`,
        `This is multi-stage analysis — use pipes.`,
        `  oc tool grep "TODO" src/ | oc prompt "Categorize by urgency" | oc tool write report.md`,
        `</example>`,
        `<example name="map-reduce">`,
        `User asks: "Summarize the architecture of this codebase."`,
        `This needs per-file analysis synthesized by a specialist — map then reduce.`,
        `  for f in $(oc tool glob "src/**/*.ts"); do`,
        `    oc tool read "$f" | oc prompt "One-line summary of this file's purpose"`,
        `  done | oc prompt -s "Software Architect" "Describe the overall system architecture"`,
        `</example>`,
        `</oc-examples>`,
        ``,
        `Write oc scripts INLINE in the bash tool command parameter — oc environment variables are only available inside the bash tool.`,
        `Scripts using oc get no timeout — Ralph loops can run for hours. The user aborts with Ctrl+C.`,
        `Verify before executing: loops terminate, oc syntax correct, errors handled.`,
        `If a script fails, fix the error and retry. If a permission is denied, skip the item gracefully.`,
        `These are composable primitives — combine freely. For complex calculations, python3 or bun work too.`,
        ``,
        `<oc-performance>`,
        `For batch operations, follow the test-first pattern:`,
        ``,
        `  Step 1 — Solve ONE item first. Figure out what works before iterating:`,
        `    files=$(oc tool glob "src/**/*.ts")`,
        `    test_file=$(echo "$files" | head -1)`,
        `    result=$(oc tool read "$test_file")`,
        `    echo "Got: $result"`,
        `    # If output is not useful (e.g. "PDF read successfully"), adapt:`,
        `    # try pdftotext, python, or a different approach BEFORE scaling.`,
        `    summary=$(echo "$result" | oc prompt "Summarize this")`,
        `    echo "Summary: $summary"`,
        `    # Verify the summary is correct. If not, fix the approach.`,
        ``,
        `  Step 2 — Scale with the PROVEN approach. Keep the full pipeline (extract + AI) in one pass per item:`,
        `    tmpdir=$(mktemp -d); count=0`,
        `    echo "$files" | while IFS= read -r f; do`,
        `      ( <your extraction step> | oc prompt "Summarize" > "$tmpdir/$(printf '%04d' $count).txt" ) &`,
        `      count=$((count+1)); [ $((count % 5)) -eq 0 ] && wait`,
        `    done; wait`,
        `    cat "$tmpdir"/*.txt  # results in order`,
        `    # IMPORTANT: always pipe into oc prompt in the SAME pass — don't split extract and summarize into separate loops.`,
        ``,
        `  Step 3 — Optional reduce (synthesize all results):`,
        `    cat "$tmpdir"/*.txt | oc prompt -s "Specialist" "Synthesize these into a report"`,
        ``,
        `Parallelism: choose a reasonable concurrency limit based on the task.`,
        `oc tool calls (deterministic): no limit. oc prompt calls: use your judgment — more for independent tasks (summarizing files), fewer for dependent tasks (iterative fixes).`,
        `Always use \`while IFS= read -r\` (not \`for f in $var\`) to handle paths with spaces.`,
        `</oc-performance>`,
        `</oc-scripting>`,
      ].join("\n"),
    ]
  }

  export async function skills(agent: Agent.Info) {
    if (Permission.disabled(["skill"], agent.permission).has("skill")) return

    const list = await Skill.available(agent)

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      // the agents seem to ingest the information about skills a bit better if we present a more verbose
      // version of them here and a less verbose version in tool description, rather than vice versa.
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }
}
