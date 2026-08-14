import { FunzzyDisconnectError, FunzzyRequestTimeoutError, FunzzyRpcError } from "./client.js";

/**
 * Transport classification for the observation use case (contract §7).
 *
 * The application never imports transport errors; the composition root
 * injects this classifier. Typed client errors decide first; generic messages
 * are matched against the curated transport patterns owned by this repo's
 * sockets. Anything unrecognized fails closed as "unknown" — never guessed.
 */

const TRANSPORT_PATTERN =
  /unavailable after|closed the socket|timed out after|exceeded 64KB|ECONN|ENOENT|EPIPE|EHOSTUNREACH|connect refused|EADDRINUSE/i;

export function classifyObservationError(error: unknown): "disconnect" | "unknown" {
  if (error instanceof FunzzyDisconnectError || error instanceof FunzzyRequestTimeoutError) {
    return "disconnect";
  }
  if (error instanceof FunzzyRpcError) return "unknown";
  if (error instanceof Error) {
    if (error.message.startsWith("Funzzy RPC error")) return "unknown";
    if (TRANSPORT_PATTERN.test(error.message)) return "disconnect";
  }
  return "unknown";
}
