import { SubmissionService } from "./submission";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { AppError, type ApplicationStore, type Caller } from "./repository";
import { STATUSES, type Status } from "./event";
import { logger } from "./logger";
import { attachmentDisposition } from "./resume-file";
import { requestContext } from "./request-context.middleware";

function caller(req: Request): Caller {
  const userId = req.get("X-User-Id")?.trim();
  const role = req.get("X-User-Role");
  const companyId = req.get("X-Company-Id")?.trim();
  if (!userId || !role)
    throw new AppError(
      401,
      "MISSING_IDENTITY",
      "Verified gateway identity is required",
    );
  if (role !== "seeker" && role !== "recruiter")
    throw new AppError(403, "FORBIDDEN", "Unsupported account role");
  if (role === "recruiter" && !companyId)
    throw new AppError(
      401,
      "MISSING_IDENTITY",
      "Verified recruiter company is required",
    );
  return { userId, role, companyId };
}
export function createApp(
  store: ApplicationStore,
  readiness: () => Promise<{ database: boolean; broker: boolean }>,
  submission?: SubmissionService,
) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", service: "application" }),
  );
  app.get("/ready", async (_req, res) => {
    const state = await readiness();
    res.status(state.database ? 200 : 503).json({
      status: state.database
        ? state.broker
          ? "ready"
          : "degraded"
        : "unavailable",
      ...state,
    });
  });
  // After the checks polled every few seconds, so they are not logged; before the
  // body parser, so a malformed body is logged with its request id too.
  app.use(requestContext);
  // Only submission carries a base64 resume (5 MB file ~ 6.7 MB of JSON).
  const smallJson = express.json({ limit: "16kb" });
  const submissionJson = express.json({ limit: "8mb" });
  app.post("/api/applications", submissionJson);
  app.use((req, res, next) =>
    req.body !== undefined ? next() : smallJson(req, res, next),
  );
  app.use("/api", (req, _res, next) => {
    try {
      resCaller(req, caller(req));
      next();
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/applications", async (req, res) => {
    if (!submission)
      throw new AppError(
        503,
        "SERVICE_UNAVAILABLE",
        "Application submission is unavailable",
      );
    const application = await submission.submitApplication(
      req.body,
      getCaller(req),
      req.get("Authorization"),
    );
    res
      .location(`/api/applications/${application.id}`)
      .status(201)
      .json({ application });
  });
  app.get("/api/applications/mine", async (req, res) =>
    res.json({ applications: await store.mine(getCaller(req)) }),
  );
  app.get("/api/applications", async (req, res) => {
    const jobId = req.query.jobId;
    if (typeof jobId !== "string" || !jobId.trim() || jobId.length > 200)
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "jobId is required (max 200 characters)",
      );
    res.json({ applications: await store.applicants(jobId, getCaller(req)) });
  });
  app.get("/api/applications/:applicationId/resume-file", async (req, res) => {
    const file = await store.getResumeFile(
      req.params.applicationId as string,
      getCaller(req),
    );
    res
      .status(200)
      .set({
        "Content-Type": file.contentType,
        "Content-Disposition": attachmentDisposition(file.fileName),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      })
      .send(file.content);
  });
  app.get("/api/applications/:applicationId", async (req, res) =>
    res.json({
      application: await store.get(
        req.params.applicationId as string,
        getCaller(req),
      ),
    }),
  );
  app.patch("/api/applications/:applicationId/status", async (req, res) => {
    const identity = getCaller(req);
    if (identity.role !== "recruiter")
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only recruiters can change application status",
      );
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !["status", "note"].includes(k)) ||
      !STATUSES.includes(body.status) ||
      (body.note !== undefined &&
        (typeof body.note !== "string" || body.note.length > 2000))
    )
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Send a valid status and optional note (max 2000 characters)",
      );
    res.json(
      await store.update(
        req.params.applicationId as string,
        body.status as Status,
        body.note?.trim(),
        identity,
      ),
    );
  });
  app.use((_req, _res, next) =>
    next(new AppError(404, "ROUTE_NOT_FOUND", "Route not found")),
  );
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.httpStatus).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }
    if (
      error?.type === "entity.parse.failed" ||
      error?.type === "entity.too.large"
    ) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid JSON or request body too large",
        },
      });
      return;
    }
    // Database errors and timeouts never expose connection strings or raw SQL details.
    logger.error("Application operation failed");
    res.status(503).json({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Application storage is unavailable",
      },
    });
  });
  return app;
}
function resCaller(req: Request, identity: Caller): void {
  (req as Request & { caller: Caller }).caller = identity;
}
function getCaller(req: Request): Caller {
  return (req as Request & { caller: Caller }).caller;
}
