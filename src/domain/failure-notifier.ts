import type { WatcherStatus } from "./watcher.js";

export function createFailureNotifier(
  sessionId: string,
  sendFailure: (status: WatcherStatus) => void,
) {
  let sentGeneration: number | undefined;

  return (
    status: WatcherStatus,
    isAgentIdle: boolean,
    responderSessionId: string | null,
  ): boolean => {
    if (status.state !== "failed" || !isAgentIdle) return false;
    if (responderSessionId !== sessionId) return false;
    if (sentGeneration === status.generation) return false;

    sendFailure(status);
    sentGeneration = status.generation;
    return true;
  };
}
