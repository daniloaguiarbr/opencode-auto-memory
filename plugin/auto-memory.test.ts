import { describe, expect, test } from "bun:test"

import { __test__ } from "./auto-memory"

describe("opencode-auto-memory heuristics", () => {
  test("recognizes Serena memory tools with MCP-style prefixes", () => {
    expect(__test__.toolNameMatches("write_memory", ["write_memory"])).toBe(true)
    expect(__test__.toolNameMatches("serena__write_memory", ["write_memory"])).toBe(true)
    expect(__test__.toolNameMatches("mcp.serena.edit_memory", ["edit_memory"])).toBe(true)
    expect(__test__.toolNameMatches("read_memory", ["write_memory", "edit_memory"])).toBe(false)
  })

  test("detects MEMORY.md edits from patch parts", () => {
    expect(
      __test__.partTouchesMemoryFile({
        type: "patch",
        files: ["MEMORY.md", "src/index.ts"],
      }),
    ).toBe(true)

    expect(
      __test__.partTouchesMemoryFile({
        type: "patch",
        files: ["README.md"],
      }),
    ).toBe(false)
  })

  test("detects MEMORY.md edits from tool inputs", () => {
    expect(
      __test__.partTouchesMemoryFile({
        type: "tool",
        tool: "apply_patch",
        state: {
          input: {
            filePath: "MEMORY.md",
          },
        },
      }),
    ).toBe(true)
  })

  test("requires both Serena and MEMORY evidence", () => {
    const evidence = __test__.getPersistenceEvidence([
      {
        type: "tool",
        tool: "serena__write_memory",
        state: {
          input: {
            memory_name: "session/test",
          },
        },
      },
      {
        type: "patch",
        files: ["MEMORY.md"],
      },
    ])

    expect(evidence.hasSerenaPersistence).toBe(true)
    expect(evidence.hasMemoryPersistence).toBe(true)
  })
})
