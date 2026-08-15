import type { WatcherTarget } from "./watcher.js";

export function formatTargets(targets: WatcherTarget[]): string {
  if (targets.length === 0) return "No Funzzy targets configured";
  return targets
    .map((target) => {
      const estimate = target.estimate === undefined ? "" : ` (${formatEstimate(target)})`;
      return `- ${target.name}: ${target.commands.join(" && ")}${estimate}`;
    })
    .join("\n");
}

function formatEstimate(target: WatcherTarget): string {
  const estimate = target.estimate;
  if (estimate === undefined) return "";
  return [
    "estimate",
    `typical=${formatMilliseconds(estimate.typicalMs)}`,
    `upper=${formatMilliseconds(estimate.upperMs)}`,
    `timeout=${formatMilliseconds(estimate.recommendedTimeoutMs)}`,
    estimate.confidence,
    `n=${estimate.samples}`,
  ].join(" ");
}

function formatMilliseconds(milliseconds: number): string {
  return milliseconds % 1_000 === 0 ? `${milliseconds / 1_000}s` : `${milliseconds}ms`;
}
