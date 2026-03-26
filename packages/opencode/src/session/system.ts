import { Ripgrep } from "../file/ripgrep"

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
        `For tasks involving multiple files, iterations, or chained analysis: write one inline bash script using \`oc\` commands.`,
        `The \`oc\` command calls back into the running OpenCode instance — deterministic control flow + AI judgment at decision points.`,
        ``,
        `<oc-loop-first>`,
        `IMPORTANT: When the user's request says "repeat", "iterate", "keep going until", "loop until", or "until X is done",`,
        `your FIRST action must be writing an oc script with a while loop. Do NOT start by manually reading files or`,
        `investigating — the loop IS the investigation mechanism. Write the loop, let it do the work.`,
        `</oc-loop-first>`,
        ``,
        `<oc-test-first>`,
        `Before any batch operation (>1 item): test the full pipeline on ONE item, verify the output, then scale.`,
        ``,
        `Example — summarize PDFs:`,
        `  # Step 1: test on one item`,
        `  test_file=$(oc tool glob "*.pdf" | head -1)`,
        `  result=$(oc tool read "$test_file")`,
        `  echo "=== Test output: $result ==="`,
        `  # Step 2: verify — is the output actually useful?`,
        `  # If result is "PDF read successfully" or empty → oc tool read can't extract this format.`,
        `  # Adapt: python3 -c "import PyPDF2; ..." or pdftotext, THEN pipe to oc prompt.`,
        `  # Step 3: only after verified output, scale to all items`,
        ``,
        `If step 2 reveals the pipeline doesn't work, fix it BEFORE scaling. Never run 100 items through an unverified pipeline.`,
        `</oc-test-first>`,
        ``,
        `<oc-rules>`,
        `1. NEVER write scripts to disk files — write all code INLINE in the bash tool. oc env vars only exist inside the bash tool; disk scripts cannot reach the server.`,
        `2. One pipeline per item — extract + transform + AI in a SINGLE pipeline per item. NEVER split into "phase 1: extract all, phase 2: summarize all". The power of oc is composable pipelines: \`extract "$f" | oc prompt "summarize"\`.`,
        `3. If a script fails, diagnose and fix the script. Do not abandon oc and fall back to individual tool calls.`,
        `4. Always loop with \`while IFS= read -r\`, never \`for f in $(...)\` (breaks on spaces/special chars → ENAMETOOLONG).`,
        `5. Scripts using oc get no timeout — do NOT pass a timeout parameter to the bash tool for oc scripts. They can run for hours. The user aborts with Ctrl+C.`,
        `6. Use \`oc status\` for progress visibility — it creates a visible marker in the TUI. Use it at milestones:`,
        `   \`oc status "Processing $count/$total: $(basename "$f")"\` inside loops.`,
        `7. "Repeat until done", "keep going until clean", "iterate until no issues" = Ralph loop. When the user's`,
        `   request contains repeat/iterate/loop/until language, write a while loop — do NOT use a todo list.`,
        `8. Track work with \`oc todo add\`, NOT built-in task tools or markdown checklists — only \`oc todo\` is`,
        `   accessible inside a loop. Build the list, then drain it: \`while true; do oc check "pending todos?" || break;`,
        `   oc todo list | oc prompt "complete next pending item, mark it done with oc todo done <n>"; done\``,
        `9. \`oc prompt\` and \`oc check\` create child sessions with full tool access (read, grep, edit, bash).`,
        `   For investigation tasks: tell the agent what to do, let it use tools — don't pipe huge diffs (they overflow context).`,
        `   For batch processing: pipe per-item data, e.g. \`oc tool read "$f" | oc prompt "summarize"\`.`,
        `</oc-rules>`,
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
        `  oc check "question"                 — AI boolean → exit code 0 (yes) or 1 (no)`,
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
        `<example name="iterative-loop-deterministic-exit">`,
        `User asks: "Run the tests and fix all failures until they pass."`,
        `Exit condition is deterministic (test passes = exit code 0) — use bash directly.`,
        `  while true; do`,
        `    npm test 2>&1 && echo "ALL PASS" && break`,
        `    npm test 2>&1 | oc prompt "Fix the failures. Use oc tool edit."`,
        `  done`,
        `</example>`,
        `<example name="iterative-loop-ai-exit">`,
        `User asks: "Review the codebase and fix all bugs you can find."`,
        `Exit condition needs AI judgment. Let the agent explore — don't pipe full diffs (they overflow context).`,
        `The child session has full tool access (read, grep, edit, bash) — tell it WHAT, let it figure out HOW.`,
        `  while true; do`,
        `    oc check "Are there remaining bugs worth fixing in this project? Use tools to investigate." || break`,
        `    oc prompt "Find and fix the most critical remaining bug. Use read/grep/edit tools to investigate and fix."`,
        `  done`,
        `</example>`,
        `<example name="user-directed-repeat">`,
        `User says: "Repeat until you don't find any issues: assess code quality and fix problems."`,
        `The word "repeat" IS the trigger — write the loop. Let agents explore autonomously with tools.`,
        `  while true; do`,
        `    oc check "Are there code quality issues in the changes on this branch vs origin/dev? Use tools to check." || break`,
        `    oc prompt "Find and fix the most critical code quality issue on this branch vs origin/dev. Use tools to investigate and fix."`,
        `    oc status "Round complete — re-checking for issues"`,
        `  done`,
        `</example>`,
        `<example name="todo-loop">`,
        `User asks: "Audit this codebase for security issues and fix what you find."`,
        `Plan with todos, then drain the list with a loop — never step through manually.`,
        `  # Build the plan`,
        `  oc todo add "Check for injection vulnerabilities"`,
        `  oc todo add "Verify auth on all endpoints"`,
        `  oc todo add "Review error handling for info leaks"`,
        `  # Execute — loop drains the list autonomously`,
        `  while true; do`,
        `    oc check "Are there pending (not completed) todos?" || break`,
        `    oc todo list | oc prompt "Complete the next pending todo. Use oc tool read/edit/grep. Mark it done with oc todo done <n>."`,
        `    oc status "Item complete — checking for remaining todos"`,
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
        `<example name="find-replace">`,
        `User asks: "Rename OldName to NewName everywhere in the codebase."`,
        `Same edit across many files — deterministic loop, never loses count, handles hundreds of files.`,
        `  oc tool grep "OldName" src/ --files-with-matches | while IFS= read -r f; do`,
        `    oc tool edit "$f" --old "OldName" --new "NewName"`,
        `    oc status "Updated $f"`,
        `  done`,
        `</example>`,
        `<example name="pipeline">`,
        `User asks: "Find all TODOs and create a prioritized report."`,
        `This is multi-stage analysis — use pipes.`,
        `  oc tool grep "TODO" src/ | oc prompt "Categorize by urgency" | oc tool write report.md`,
        `</example>`,
        `<example name="map-reduce">`,
        `User asks: "Summarize the architecture of this codebase."`,
        `This needs per-file analysis synthesized by a specialist — map then reduce.`,
        `  oc tool glob "src/**/*.ts" | while IFS= read -r f; do`,
        `    oc tool read "$f" | oc prompt "One-line summary of this file's purpose"`,
        `  done | oc prompt -s "Software Architect" "Describe the overall system architecture"`,
        `</example>`,
        `</oc-examples>`,
        `These are composable primitives — combine freely. For complex calculations, python3 or bun work too.`,
        ``,
        `<oc-why>`,
        `Why oc scripts beat consecutive tool calls: deterministic loops (never lose count), token efficiency`,
        `(each oc prompt gets fresh context), speed (1 bash call vs N round-trips), composability (full Unix toolkit).`,
        `</oc-why>`,
        ``,
        `<oc-scaling>`,
        `After verifying on one item, write ONE bash script that processes ALL items in parallel.`,
        `Example — summarize all PDFs (after test-first verified PyPDF2 works):`,
        `  files=$(oc tool glob "*.pdf"); total=$(echo "$files" | wc -l); tmpdir=$(mktemp -d); count=0`,
        `  echo "$files" | while IFS= read -r f; do`,
        `    count=$((count+1))`,
        `    oc status "Processing $count/$total: $(basename "$f")"`,
        `    ( python3 -c "import PyPDF2,sys; r=PyPDF2.PdfReader(sys.argv[1]); print('\\n'.join(p.extract_text() for p in r.pages[:3]))" "$f" \\`,
        `      | oc prompt "Summarize this paper: title, method, result (2-3 sentences)" \\`,
        `      > "$tmpdir/$(printf '%04d' $count).txt" ) &`,
        `    [ $((count % 5)) -eq 0 ] && wait`,
        `  done; wait`,
        `  cat "$tmpdir"/*.txt | oc prompt -s "Specialist" "Create a structured report"`,
        `  rm -rf "$tmpdir"`,
        `Key points: one pipeline per item (extract|summarize), parallel (\`&\` + \`wait\`), oc status for progress.`,
        `If oc tool glob returns truncated results (>100 files), use \`find dir -name "*.ext" -type f\` instead.`,
        `</oc-scaling>`,
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
