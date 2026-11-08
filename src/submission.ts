import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  AppError,
  type Application,
  type ApplicationStore,
  type Caller,
} from "./repository";
import { parseResumeFile, type ResumeUpload } from "./resume-file";
import resumeSchema from "../contracts/approved-resume.v1.schema.json";
import matchSchema from "../contracts/match-result.v1.schema.json";

export interface ApprovedResume {
  draftId: string;
  candidateId: string;
  jobId: string;
  format: "company" | "personal";
  sections: {
    id: string;
    kind: string;
    title: string;
    meta: string;
    emphasized: boolean;
    bullets: { id: string; text: string; tailored: boolean }[];
  }[];
  approvedAt: string;
  updatedAt: string;
}
export interface MatchResult {
  jobId: string;
  candidateId: string;
  score: number;
  breakdown: {
    skills: number;
    experience: number;
    education: number;
    preferences: number;
  };
  matchedSkills: string[];
  missingSkills: string[];
  strengths: string[];
  gaps: string[];
  explanation: string;
  computedAt: string;
}
export interface SubmissionJob {
  id: string;
  title: string;
  companyId: string;
  status: string;
  applicationDeadline?: string;
  requireCoverLetter: boolean;
}
export interface SubmissionDevelopment {
  fixtureSet: string | null;
  sources: {
    jobPosting: "live" | "fixture";
    resumePreparation: "live" | "fixture";
    jobDiscovery: "live" | "fixture";
    candidateProfile: "live" | "fixture";
  };
}
export interface SubmissionData {
  development: SubmissionDevelopment | null;
  jobId: string;
  companyId: string;
  candidate: { id: string; name: string; email: string };
  jobSnapshot: Application["jobSnapshot"];
  resumeReference: {
    draftId: string;
    format: "company" | "personal";
    approvedAt: string;
    updatedAt: string;
  } | null;
  resumeSnapshot: ApprovedResume | null;
  /** Set when the seeker uploaded their own file; the tailored fields are then null. */
  resumeUpload: ResumeUpload | null;
  resumeSource: "tailored" | "uploaded";
  matchSnapshot: MatchResult & { summary: string; capturedAt: string };
  coverLetter: string | null;
}
export interface SubmissionSources {
  development?: SubmissionDevelopment;
  forSubmission?(jobId: string, caller: Caller): SubmissionSources;
  getJob(
    jobId: string,
    caller: Caller,
    authorization: string,
  ): Promise<SubmissionJob>;
  getApprovedResume(
    jobId: string,
    caller: Caller,
    authorization: string,
  ): Promise<ApprovedResume>;
  getMatchResult(
    jobId: string,
    caller: Caller,
    authorization: string,
  ): Promise<MatchResult>;
  getCandidate(
    caller: Caller,
    authorization: string,
  ): Promise<SubmissionData["candidate"]>;
}
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
export const validateResume = ajv.compile<ApprovedResume>(resumeSchema);
export const validateMatch = ajv.compile<MatchResult>(matchSchema);
const validateCandidate = ajv.compile<SubmissionData["candidate"]>({
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "email"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 200 },
    email: { type: "string", format: "email", maxLength: 254 },
  },
});
export function upstreamInvalid(source: string): never {
  throw new AppError(
    502,
    "UPSTREAM_RESPONSE_INVALID",
    `${source} returned an invalid response`,
  );
}
export function parseSubmission(body: unknown): {
  jobId: string;
  coverLetter: string | null;
  resumeFile: ResumeUpload | null;
} {
  const value = body as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !["jobId", "coverLetter", "resumeFile"].includes(k)) ||
    typeof value.jobId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(value.jobId) ||
    (value.coverLetter !== undefined &&
      (typeof value.coverLetter !== "string" ||
        value.coverLetter.length > 10000))
  )
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Send jobId and an optional coverLetter (max 10000 characters)",
    );
  return {
    jobId: value.jobId,
    coverLetter: (value.coverLetter as string | undefined)?.trim() || null,
    resumeFile:
      value.resumeFile === undefined ? null : parseResumeFile(value.resumeFile),
  };
}
export class SubmissionService {
  constructor(
    private readonly store: ApplicationStore,
    private readonly sources: SubmissionSources,
  ) {}
  async submitApplication(
    body: unknown,
    caller: Caller,
    authorization?: string,
  ): Promise<Application> {
    if (caller.role !== "seeker")
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only job seekers can submit applications",
      );
    const input = parseSubmission(body);
    // Gateway remains the authenticator. This checks shape only, then forwards the token to owning services.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        caller.userId,
      )
    )
      throw new AppError(
        401,
        "MISSING_IDENTITY",
        "Submission requires a verified seeker UUID",
      );
    if (!authorization || !/^Bearer\s+[^\s]+$/i.test(authorization))
      throw new AppError(
        401,
        "MISSING_AUTHORIZATION",
        "The gateway must forward the seeker's bearer token",
      );
    if (await this.store.hasApplication(input.jobId, caller.userId))
      throw new AppError(
        409,
        "ALREADY_APPLIED",
        "You have already applied to this job",
      );
    const sources =
      this.sources.forSubmission?.(input.jobId, caller) ?? this.sources;
    // BUC-2C: job check -> approved resume -> match -> persist. No write before all checks pass.
    const job = await sources.getJob(input.jobId, caller, authorization);
    if (
      job.id !== input.jobId ||
      !job.title.trim() ||
      job.title.length > 200 ||
      !job.companyId.trim() ||
      job.companyId.length > 200
    )
      upstreamInvalid("Job Posting");
    if (job.status !== "OPEN")
      throw new AppError(
        409,
        "JOB_NOT_OPEN",
        "This job is no longer accepting applications",
      );
    const checkDeadline = () => {
      if (
        job.applicationDeadline &&
        !Number.isFinite(Date.parse(job.applicationDeadline))
      )
        upstreamInvalid("Job Posting");
      if (
        job.applicationDeadline &&
        Date.parse(job.applicationDeadline) <= Date.now()
      )
        throw new AppError(
          409,
          "APPLICATION_DEADLINE_PASSED",
          "The application deadline has passed",
        );
    };
    checkDeadline();
    if (job.requireCoverLetter && !input.coverLetter)
      throw new AppError(
        409,
        "COVER_LETTER_REQUIRED",
        "This job requires a cover letter",
      );
    // An uploaded file replaces the AI-tailored resume, so no approved draft is needed.
    let resume: ApprovedResume | null = null;
    if (!input.resumeFile) {
      resume = await sources.getApprovedResume(
        input.jobId,
        caller,
        authorization,
      );
      if (
        !validateResume(resume) ||
        resume.candidateId !== caller.userId ||
        resume.jobId !== input.jobId
      )
        upstreamInvalid("Resume Preparation");
    }
    const match = await sources.getMatchResult(
      input.jobId,
      caller,
      authorization,
    );
    if (
      !validateMatch(match) ||
      match.candidateId !== caller.userId ||
      match.jobId !== input.jobId
    )
      upstreamInvalid("Job Discovery");
    // Contact information comes from the profile owner, never from the submission body or decoded unverified JWT.
    const candidate = await sources.getCandidate(caller, authorization);
    if (candidate.id !== caller.userId) upstreamInvalid("Candidate Profile");
    if (!validateCandidate(candidate) || !candidate.name.trim())
      throw new AppError(
        409,
        "PROFILE_INCOMPLETE",
        "Your profile needs a name and valid email before applying",
      );
    checkDeadline();
    return this.store.submit(
      {
        development: sources.development
          ? structuredClone(sources.development)
          : null,
        jobId: input.jobId,
        companyId: job.companyId,
        candidate,
        jobSnapshot: { id: job.id, title: job.title, companyId: job.companyId },
        resumeReference: resume
          ? {
              draftId: resume.draftId,
              format: resume.format,
              approvedAt: resume.approvedAt,
              updatedAt: resume.updatedAt,
            }
          : null,
        resumeSnapshot: resume,
        resumeUpload: input.resumeFile,
        resumeSource: input.resumeFile ? "uploaded" : "tailored",
        matchSnapshot: {
          ...match,
          summary: match.explanation,
          capturedAt: new Date().toISOString(),
        },
        coverLetter: input.coverLetter,
      },
      caller,
    );
  }
}
