import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { integer } from "./config";
import { logger } from "./logger";
import { AppError, type Caller } from "./repository";
import { currentRequestId, REQUEST_ID_KEY } from "./request-context";
import {
  upstreamInvalid,
  type ApprovedResume,
  type MatchResult,
  type SubmissionSources,
  type SubmissionJob,
  type SubmissionData,
} from "./submission";

// Only transport unavailability is eligible for the opt-in development fallback.
// Ordinary HTTP/gRPC business errors retain their normal error codes.
export class UpstreamUnavailableError extends AppError {
  constructor(source: string) {
    super(503, "SERVICE_UNAVAILABLE", `${source} is unavailable or timed out`);
  }
}
function logUnavailable(source: string, requestId?: string): void {
  logger.error(`${source} is unavailable or timed out`, {
    requestId,
    upstream: source,
  });
}
type Message = Record<string, any>;
export interface SourceConfig {
  jobPostingTarget: string;
  resumeTarget: string;
  discoveryUrl: string;
  profileUrl: string;
  timeoutMs: number;
  grpcTls: boolean;
  grpcCaFile?: string;
}
export function sourceConfig(): SourceConfig {
  if (
    process.env.UPSTREAM_GRPC_TLS &&
    !["true", "false"].includes(process.env.UPSTREAM_GRPC_TLS)
  )
    throw new Error("Invalid UPSTREAM_GRPC_TLS");
  const config: SourceConfig = {
    jobPostingTarget: process.env.JOB_POSTING_GRPC_URL || "localhost:50052",
    resumeTarget: process.env.RESUME_PREPARATION_GRPC_URL || "localhost:50053",
    discoveryUrl:
      process.env.JOB_DISCOVERY_SERVICE_URL || "http://localhost:3002",
    profileUrl:
      process.env.CANDIDATE_PROFILE_SERVICE_URL || "http://localhost:3001",
    timeoutMs: integer("UPSTREAM_TIMEOUT_MS", 5000, 100, 30000),
    grpcTls: process.env.UPSTREAM_GRPC_TLS === "true",
    grpcCaFile: process.env.UPSTREAM_GRPC_CA_FILE,
  };
  for (const value of [config.discoveryUrl, config.profileUrl]) {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname)
    )
      throw new Error(
        "Upstream REST URLs must be HTTP(S) origins without credentials",
      );
  }
  return config;
}
export function loadService(
  file: string,
  namespace: "jobposting" | "resumepreparation",
): grpc.ServiceClientConstructor {
  const loaded = grpc.loadPackageDefinition(
    loadSync(join(process.cwd(), "proto", file), {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    }),
  ) as unknown as {
    rolefit: Record<
      string,
      { v1: Record<string, grpc.ServiceClientConstructor> }
    >;
  };
  return loaded.rolefit[namespace].v1[
    namespace === "jobposting"
      ? "JobPostingService"
      : "ResumePreparationService"
  ];
}
export class UpstreamClients implements SubmissionSources {
  private readonly job: grpc.Client;
  private readonly resume: grpc.Client;
  constructor(private readonly config: SourceConfig = sourceConfig()) {
    const credentials = config.grpcTls
      ? grpc.credentials.createSsl(
          config.grpcCaFile ? readFileSync(config.grpcCaFile) : undefined,
        )
      : grpc.credentials.createInsecure();
    const options = { "grpc.max_receive_message_length": 2 * 1024 * 1024 };
    this.job = new (loadService("job-posting.proto", "jobposting"))(
      config.jobPostingTarget,
      credentials,
      options,
    );
    this.resume = new (loadService(
      "resume-preparation.proto",
      "resumepreparation",
    ))(config.resumeTarget, credentials, options);
  }
  close(): void {
    this.job.close();
    this.resume.close();
  }
  private rpc(
    client: grpc.Client,
    method: string,
    request: Message,
    caller: Caller,
    authorization: string,
    source: string,
  ): Promise<Message> {
    const metadata = new grpc.Metadata();
    metadata.set("x-user-id", caller.userId);
    metadata.set("x-user-role", "seeker");
    metadata.set("authorization", authorization);
    // Read now: the callback below may run outside the request's async context.
    const requestId = currentRequestId();
    if (requestId) metadata.set(REQUEST_ID_KEY, requestId);
    // Never forward a seeker-supplied company or any arbitrary request header.
    return new Promise((resolve, reject) => {
      const invoke = (client as unknown as Record<string, Function>)[
        method
      ].bind(client);
      invoke(
        request,
        metadata,
        { deadline: Date.now() + this.config.timeoutMs },
        (error: grpc.ServiceError | null, result: Message) => {
          if (!error) return resolve(result);
          if (
            error.code === grpc.status.DEADLINE_EXCEEDED ||
            error.code === grpc.status.UNAVAILABLE ||
            error.code === grpc.status.CANCELLED
          ) {
            logUnavailable(source, requestId);
            return reject(new UpstreamUnavailableError(source));
          }
          if (error.code === grpc.status.UNAUTHENTICATED)
            return reject(
              new AppError(
                401,
                "UPSTREAM_UNAUTHENTICATED",
                `${source} did not accept the forwarded identity`,
              ),
            );
          if (error.code === grpc.status.PERMISSION_DENIED)
            return reject(
              new AppError(403, "FORBIDDEN", `${source} denied access`),
            );
          if (error.code === grpc.status.NOT_FOUND)
            return reject(
              new AppError(
                source === "Job Posting" ? 404 : 409,
                source === "Job Posting"
                  ? "JOB_NOT_FOUND"
                  : "RESUME_DRAFT_NOT_FOUND",
                source === "Job Posting"
                  ? "Job not found"
                  : "Prepare and approve a resume before applying",
              ),
            );
          if (
            source === "Resume Preparation" &&
            error.code === grpc.status.FAILED_PRECONDITION
          )
            return reject(
              new AppError(
                409,
                "RESUME_NOT_APPROVED",
                "Approve your resume before applying",
              ),
            );
          reject(
            new AppError(
              502,
              "UPSTREAM_ERROR",
              `${source} could not complete the request`,
            ),
          );
        },
      );
    });
  }
  async getJob(
    jobId: string,
    caller: Caller,
    authorization: string,
  ): Promise<SubmissionJob> {
    const result = await this.rpc(
      this.job,
      "GetJob",
      { job_id: jobId },
      caller,
      authorization,
      "Job Posting",
    );
    const job = result?.job;
    if (
      !job ||
      typeof job.id !== "string" ||
      typeof job.title !== "string" ||
      typeof job.company_id !== "string" ||
      !["JOB_STATUS_OPEN", "JOB_STATUS_CLOSED", "JOB_STATUS_DRAFT"].includes(
        job.status,
      ) ||
      (job.application_settings?.application_deadline &&
        typeof job.application_settings.application_deadline !== "string")
    )
      upstreamInvalid("Job Posting");
    return {
      id: job.id,
      title: job.title,
      companyId: job.company_id,
      status: job.status.replace("JOB_STATUS_", ""),
      applicationDeadline:
        job.application_settings?.application_deadline || undefined,
      requireCoverLetter:
        job.application_settings?.require_cover_letter === true,
    };
  }
  async getApprovedResume(
    jobId: string,
    caller: Caller,
    authorization: string,
  ): Promise<ApprovedResume> {
    const result = await this.rpc(
      this.resume,
      "GetApprovedResume",
      { candidate_id: caller.userId, job_id: jobId },
      caller,
      authorization,
      "Resume Preparation",
    );
    const resume = result?.resume;
    if (!resume || !Array.isArray(resume.sections))
      upstreamInvalid("Resume Preparation");
    return {
      draftId: resume.draft_id,
      candidateId: resume.candidate_id,
      jobId: resume.job_id,
      format:
        resume.format === "RESUME_FORMAT_COMPANY"
          ? "company"
          : resume.format === "RESUME_FORMAT_PERSONAL"
            ? "personal"
            : resume.format,
      sections: resume.sections.map((s: Message) => ({
        id: s.id,
        kind: s.kind,
        title: s.title,
        meta: s.meta,
        emphasized: s.emphasized,
        bullets: Array.isArray(s.bullets)
          ? s.bullets.map((b: Message) => ({
              id: b.id,
              text: b.text,
              tailored: b.tailored,
            }))
          : s.bullets,
      })),
      approvedAt: resume.approved_at,
      updatedAt: resume.updated_at,
    };
  }
  /** Service-to-service calls made by the reminder scheduler, outside any user request. */
  private readonly system: Caller = {
    userId: "system:deadline-reminders",
    role: "seeker",
  };
  async listPublishedJobs(): Promise<
    Array<{ id: string; title: string; deadline?: string }>
  > {
    const jobs: Array<{ id: string; title: string; deadline?: string }> = [];
    for (let page = 1; ; page++) {
      const result = await this.rpc(
        this.job,
        "ListJobs",
        { status: "JOB_STATUS_OPEN", page, limit: 100 },
        this.system,
        "",
        "Job Posting",
      );
      const batch: Message[] = Array.isArray(result?.jobs) ? result.jobs : [];
      for (const job of batch) {
        if (typeof job.id !== "string" || typeof job.title !== "string")
          upstreamInvalid("Job Posting");
        jobs.push({
          id: job.id,
          title: job.title,
          deadline: job.application_settings?.application_deadline || undefined,
        });
      }
      if (batch.length < 100 || page * 100 >= Number(result?.total ?? 0)) break;
    }
    return jobs;
  }
  async listDraftsForJobs(
    jobIds: string[],
  ): Promise<Array<{ candidateId: string; jobId: string }>> {
    const result = await this.rpc(
      this.resume,
      "ListDraftsForJobs",
      { job_ids: jobIds },
      this.system,
      "",
      "Resume Preparation",
    );
    if (!Array.isArray(result?.drafts)) upstreamInvalid("Resume Preparation");
    return result.drafts.map((d: Message) => ({
      candidateId: d.candidate_id,
      jobId: d.job_id,
    }));
  }
  /**
   * Candidate Profile only serves /api/profiles/me for the signed-in user, so the
   * scheduler needs a credential that profile accepts for this candidate.
   * REMINDER_PROFILE_AUTHORIZATION is that header value; unset means lookups fail
   * (and the reminder is skipped and logged).
   */
  async getCandidateForReminder(
    candidateId: string,
  ): Promise<{ name: string; email: string }> {
    const authorization = process.env.REMINDER_PROFILE_AUTHORIZATION;
    if (!authorization)
      throw new AppError(
        503,
        "SERVICE_UNAVAILABLE",
        "No service credential for Candidate Profile lookups",
      );
    const candidate = await this.getCandidate(
      { userId: candidateId, role: "seeker" },
      authorization,
    );
    return { name: candidate.name, email: candidate.email };
  }
  private async http(
    origin: string,
    path: string,
    caller: Caller,
    authorization: string,
    source: string,
  ): Promise<Message> {
    const requestId = currentRequestId();
    try {
      const response = await fetch(new URL(path, origin), {
        headers: {
          "X-User-Id": caller.userId,
          "X-User-Role": "seeker",
          Authorization: authorization,
          Accept: "application/json",
          ...(requestId ? { "X-Request-Id": requestId } : {}),
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: "manual",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 404)
          throw new AppError(
            source === "Candidate Profile" ? 409 : 404,
            source === "Candidate Profile"
              ? "PROFILE_REQUIRED"
              : "JOB_NOT_FOUND",
            source === "Candidate Profile"
              ? "Create your profile before applying"
              : "Job not found",
          );
        if (response.status === 401)
          throw new AppError(
            401,
            "UPSTREAM_UNAUTHENTICATED",
            `${source} did not accept the forwarded identity`,
          );
        if (response.status === 403)
          throw new AppError(403, "FORBIDDEN", `${source} denied access`);
        if (
          response.status === 503 ||
          response.status === 504 ||
          response.status === 429
        )
          throw new AppError(
            503,
            "SERVICE_UNAVAILABLE",
            `${source} is unavailable or timed out`,
          );
        throw new AppError(
          502,
          "UPSTREAM_ERROR",
          `${source} could not complete the request`,
        );
      }
      // Bound the streamed response as well as the advertised content length.
      if (Number(response.headers.get("content-length")) > 2 * 1024 * 1024) {
        await response.body?.cancel();
        upstreamInvalid(source);
      }
      const reader = response.body?.getReader();
      if (!reader) upstreamInvalid(source);
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          upstreamInvalid(source);
        }
        chunks.push(value);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        upstreamInvalid(source);
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        upstreamInvalid(source);
      return body as Message;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const failure = error as {
        name?: string;
        code?: string;
        cause?: { code?: string; errors?: { code?: string }[] };
      };
      const connectionCodes = [
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "EPIPE",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_SOCKET",
      ];
      const codes = [
        failure.code,
        failure.cause?.code,
        ...(failure.cause?.errors?.map((x) => x.code) ?? []),
      ];
      if (
        ["AbortError", "TimeoutError"].includes(failure.name ?? "") ||
        codes.some((code) => code && connectionCodes.includes(code))
      ) {
        logUnavailable(source, requestId);
        throw new UpstreamUnavailableError(source);
      }
      throw new AppError(
        502,
        "UPSTREAM_ERROR",
        `${source} could not complete the request`,
      );
    }
  }
  async getMatchResult(
    jobId: string,
    caller: Caller,
    authorization: string,
  ): Promise<MatchResult> {
    const result = await this.http(
      this.config.discoveryUrl,
      `/api/jobs/${encodeURIComponent(jobId)}/match`,
      caller,
      authorization,
      "Job Discovery",
    );
    // Preserve only documented fields. Unknown upstream additions cannot leak into stored snapshots.
    const {
      jobId: resultJob,
      candidateId,
      score,
      breakdown,
      matchedSkills,
      missingSkills,
      strengths,
      gaps,
      explanation,
      computedAt,
    } = result;
    return {
      jobId: resultJob,
      candidateId,
      score,
      breakdown,
      matchedSkills,
      missingSkills,
      strengths,
      gaps,
      explanation,
      computedAt,
    };
  }
  async getCandidate(
    caller: Caller,
    authorization: string,
  ): Promise<SubmissionData["candidate"]> {
    const result = await this.http(
      this.config.profileUrl,
      "/api/profiles/me",
      caller,
      authorization,
      "Candidate Profile",
    );
    return { id: result.id, name: result.name, email: result.email };
  }
}
