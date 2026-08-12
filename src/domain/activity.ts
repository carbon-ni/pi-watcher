const WORKTREE_ACTIVITY_TOOLS = new Set(["bash", "edit", "write"]);

export function recordsAgentActivity(toolName: string): boolean {
  return WORKTREE_ACTIVITY_TOOLS.has(toolName);
}
