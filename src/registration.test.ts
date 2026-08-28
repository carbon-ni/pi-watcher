import { describe, expect, it, vi } from "vitest";

import { createWatcherRegistration } from "./registration.js";

function createPort() {
  const registered: string[] = [];
  const active = new Set(["read", "bash", "edit"]);
  const port = {
    registerTool: vi.fn((tool: { name: string }) => registered.push(tool.name)),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active.clear();
      for (const name of names) active.add(name);
    },
  };
  return { registered, active, port };
}

function createDeps() {
  return {
    readConfigPresence: vi.fn().mockResolvedValue({ watchYaml: false, watchYml: false }),
    registerWatcherTools: vi.fn(),
    startWatcherSession: vi.fn().mockResolvedValue(undefined),
    resetWatcherSession: vi.fn().mockResolvedValue(undefined),
  };
}

const ctx = { cwd: "/project" } as never;

describe("createWatcherRegistration", () => {
  it("registers the watcher surface only after session_start fires with a contract file", async () => {
    const { port } = createPort();
    const deps = createDeps();
    deps.readConfigPresence.mockResolvedValue({ watchYaml: true, watchYml: false });
    const registration = createWatcherRegistration(port, deps);

    await registration.sessionStart({} as never, ctx);

    expect(deps.registerWatcherTools).toHaveBeenCalledTimes(1);
    expect(deps.startWatcherSession).toHaveBeenCalledTimes(1);
    expect(deps.resetWatcherSession).not.toHaveBeenCalled();
  });

  it("registers nothing and starts no work without a contract file", async () => {
    const { port, registered } = createPort();
    const deps = createDeps();
    const registration = createWatcherRegistration(port, deps);

    await registration.sessionStart({} as never, ctx);

    expect(deps.registerWatcherTools).not.toHaveBeenCalled();
    expect(deps.startWatcherSession).not.toHaveBeenCalled();
    expect(deps.resetWatcherSession).toHaveBeenCalledTimes(1);
    expect(registered).toEqual([]);
    expect(port.registerTool).not.toHaveBeenCalled();
  });

  it("does not register twice on repeated session_start", async () => {
    const { port } = createPort();
    const deps = createDeps();
    deps.readConfigPresence.mockResolvedValue({ watchYaml: true, watchYml: false });
    const registration = createWatcherRegistration(port, deps);

    await registration.sessionStart({} as never, ctx);
    await registration.sessionStart({} as never, ctx);

    expect(deps.registerWatcherTools).toHaveBeenCalledTimes(1);
    expect(deps.startWatcherSession).toHaveBeenCalledTimes(2);
  });

  it("deactivates previously registered watcher tools when the contract disappears", async () => {
    const { port, active } = createPort();
    const deps = createDeps();
    deps.readConfigPresence.mockResolvedValueOnce({ watchYaml: true, watchYml: false });
    const registration = createWatcherRegistration(port, deps);

    await registration.sessionStart({} as never, ctx);
    // Pi has no unregister API: the tools stay in getAllTools(); only the
    // active set can shrink.
    for (const name of ["watcher_status", "watcher_verify"]) active.add(name);

    deps.readConfigPresence.mockResolvedValueOnce({ watchYaml: false, watchYml: false });
    await registration.sessionStart({} as never, ctx);

    expect([...active]).toEqual(["read", "bash", "edit"]);
    expect(deps.resetWatcherSession).toHaveBeenCalledTimes(1);
    expect(deps.registerWatcherTools).toHaveBeenCalledTimes(1);
  });

  it("re-activates watcher tools when the contract returns after disappearing", async () => {
    const { port, active } = createPort();
    const deps = createDeps();
    const registration = createWatcherRegistration(port, deps);

    deps.readConfigPresence.mockResolvedValueOnce({ watchYaml: true, watchYml: false });
    await registration.sessionStart({} as never, ctx);
    for (const name of ["watcher_status", "watcher_observe"]) active.add(name);

    deps.readConfigPresence.mockResolvedValueOnce({ watchYaml: false, watchYml: false });
    await registration.sessionStart({} as never, ctx);
    expect([...active]).toEqual(["read", "bash", "edit"]);

    deps.readConfigPresence.mockResolvedValueOnce({ watchYaml: false, watchYml: true });
    await registration.sessionStart({} as never, ctx);

    expect(deps.registerWatcherTools).toHaveBeenCalledTimes(1);
    expect([...active].sort()).toEqual(
      [
        "bash",
        "edit",
        "read",
        "watcher_cancel",
        "watcher_observe",
        "watcher_output",
        "watcher_status",
        "watcher_targets",
        "watcher_verify",
      ].sort(),
    );
  });

  it("does not touch the active set when the gate was never opened", async () => {
    const { port } = createPort();
    const setActiveTools = vi.spyOn(port, "setActiveTools");
    const deps = createDeps();
    const registration = createWatcherRegistration(port, deps);

    await registration.sessionStart({} as never, ctx);

    expect(setActiveTools).not.toHaveBeenCalled();
  });
});
