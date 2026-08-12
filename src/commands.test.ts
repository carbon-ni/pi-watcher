import { describe, expect, it, vi } from "vitest";

import funzzyStatus from "./index.js";

describe("funzzyStatus registration", () => {
  it("registers watcher-prefixed tools", () => {
    const tools: string[] = [];
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn(),
    };

    funzzyStatus(pi as never);

    expect(tools).toEqual(["watcher_status", "watcher_targets", "watcher_verify"]);
    expect(tools).not.toContain("funzzy_status");
    expect(tools).not.toContain("funzzy_targets");
    expect(tools).not.toContain("funzzy_verify");
  });

  it("registers watcher-prefixed slash commands", () => {
    const commands: string[] = [];
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string) => commands.push(name)),
    };

    funzzyStatus(pi as never);

    expect(commands).toEqual(["watcher-targets", "watcher-responder", "watcher-status"]);
  });

  it("does not preserve deprecated funzzy-prefixed slash commands", () => {
    const commands: string[] = [];
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string) => commands.push(name)),
    };

    funzzyStatus(pi as never);

    expect(commands).not.toContain("funzzy-targets");
    expect(commands).not.toContain("funzzy-responder");
    expect(commands).not.toContain("funzzy-status");
  });
});
