import type { WatcherTarget } from "./watcher.js";

export function formatTargets(targets: WatcherTarget[]): string {
  if (targets.length === 0) return "No Funzzy targets configured";
  return targets.map((target) => `- ${target.name}: ${target.commands.join(" && ")}`).join("\n");
}
