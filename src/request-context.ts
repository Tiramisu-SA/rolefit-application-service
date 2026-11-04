import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** HTTP header and gRPC metadata key. The API Gateway creates the id; every service logs and forwards it. */
export const REQUEST_ID_KEY = "x-request-id";

// Letters, digits, ".", "_", "-" only, so a caller cannot inject log lines. Same rule as the gateway.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

const storage = new AsyncLocalStorage<string>();

/** Keeps a safe incoming id, otherwise creates a new one. */
export function resolveRequestId(incoming: unknown): string {
  return typeof incoming === "string" && SAFE_ID.test(incoming)
    ? incoming
    : randomUUID();
}

/** Runs `fn` so that everything it starts, sync or async, sees `requestId` as the current id. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run(requestId, fn);
}

/** The id of the request being handled; undefined outside a request, e.g. in the outbox worker. */
export function currentRequestId(): string | undefined {
  return storage.getStore();
}
