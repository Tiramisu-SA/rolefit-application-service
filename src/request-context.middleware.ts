import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger";
import {
  REQUEST_ID_KEY,
  resolveRequestId,
  runWithRequestId,
} from "./request-context";

/**
 * Takes the request id from the gateway (or creates one), returns it on the
 * response, and logs one line when the response is finished. Everything the
 * request runs afterwards sees the id through `currentRequestId()`.
 */
export function requestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = resolveRequestId(req.get(REQUEST_ID_KEY));
  const start = process.hrtime.bigint();
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    logger.info("request completed", {
      requestId,
      method: req.method,
      // No query string: it can hold what a user typed.
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs:
        Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10,
    });
  });
  runWithRequestId(requestId, next);
}
