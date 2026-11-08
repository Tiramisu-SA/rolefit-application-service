import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import * as grpc from "@grpc/grpc-js";
import { developmentConfig, withDevelopmentSources } from "../src/development";
import {
  DEVELOPMENT_FIXTURES,
  DEV_FIXTURE_SET,
  developmentFixture,
} from "../src/development-fixtures";
import {
  AppError,
  type Application,
  type ApplicationStore,
  type Caller,
} from "../src/repository";
import {
  SubmissionService,
  validateMatch,
  validateResume,
  type SubmissionSources,
  type SubmissionData,
} from "../src/submission";
import { UpstreamClients, UpstreamUnavailableError } from "../src/upstreams";
import { startFixtures } from "../scripts/submission-fixtures";

const alpha = DEVELOPMENT_FIXTURES[0];
const identity: Caller = { userId: alpha.candidate.id, role: "seeker" };
const token = "Bearer development-test-token";
const env = (mode: string): NodeJS.ProcessEnv => ({
  APP_ENV: "development",
  DATABASE_URL:
    "postgresql://application:application-local@localhost:5433/application_dev",
  UPSTREAM_MODE: mode,
});
function memoryStore() {
  const saved: Application[] = [];
  const store: ApplicationStore = {
    hasApplication: async () => false,
    submit: async (data: SubmissionData, caller: Caller) => {
      const at = new Date().toISOString();
      const { resumeUpload: _upload, ...snapshot } = structuredClone(data);
      const application: Application = {
        ...snapshot,
        resumeFile: null,
        resumeSource: "tailored",
        id: `app_${saved.length}`,
        candidateId: caller.userId,
        status: "Submitted",
        submittedAt: at,
        updatedAt: at,
        history: [
          { status: "Submitted", at, changedBy: caller.userId, note: null },
        ],
      };
      saved.push(application);
      return application;
    },
    get: async () => saved[0],
    getResumeFile: async () => {
      throw new Error("Not exercised");
    },
    mine: async () => saved,
    applicants: async () => saved,
    update: async () => {
      throw new Error("Not exercised");
    },
  };
  return { store, saved };
}
const fixtureSources = (): SubmissionSources => ({
  getJob: async () => structuredClone(alpha.job),
  getApprovedResume: async () => structuredClone(alpha.resume),
  getMatchResult: async () => structuredClone(alpha.match),
  getCandidate: async () => structuredClone(alpha.candidate),
});
async function closedPort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("development modes default to live, validate overrides and require a separate local dev database", () => {
  assert.deepEqual(developmentConfig({}).modes, {
    jobPosting: "live",
    resumePreparation: "live",
    jobDiscovery: "live",
    candidateProfile: "live",
  });
  for (const value of [
    { ...env("fallback"), APP_ENV: undefined },
    { ...env("fixture"), APP_ENV: "production" },
    { ...env("fallback"), DATABASE_URL: "postgresql://localhost/application" },
    {
      ...env("fallback"),
      DATABASE_URL: "postgresql://hosted.example/application_dev",
    },
    { ...env("fallback"), DATABASE_URL: undefined },
    env("anything"),
    { ...env("live"), CANDIDATE_PROFILE_MODE: "bad" },
  ])
    assert.throws(() => developmentConfig(value));
  const config = developmentConfig({
    ...env("fallback"),
    JOB_POSTING_MODE: "live",
    JOB_DISCOVERY_MODE: "fixture",
  });
  assert.equal(config.modes.jobPosting, "live");
  assert.equal(config.modes.jobDiscovery, "fixture");
  const live = fixtureSources();
  assert.equal(withDevelopmentSources(live, { APP_ENV: "production" }), live);
});

test("development fixtures satisfy real contracts, use explicit pairs and return independent copies", () => {
  for (const fixture of DEVELOPMENT_FIXTURES) {
    assert.ok(validateResume(fixture.resume));
    assert.ok(validateMatch(fixture.match));
    assert.equal(fixture.job.id, fixture.resume.jobId);
    assert.equal(fixture.candidate.id, fixture.match.candidateId);
    assert.match(fixture.candidate.email, /@example\.test$/);
  }
  assert.equal(
    developmentFixture(alpha.job.id, DEVELOPMENT_FIXTURES[1].candidate.id),
    undefined,
  );
  const copy = developmentFixture(alpha.job.id, alpha.candidate.id)!;
  copy.match.score = 0;
  assert.equal(
    developmentFixture(alpha.job.id, alpha.candidate.id)!.match.score,
    70,
  );
});

test("fixture mode performs no live calls, keeps identity checks and enforces sample job requirements", async () => {
  const unavailable = async (): Promise<never> => {
    throw new Error("Fixture mode called a live service");
  };
  const sources = withDevelopmentSources(
    {
      getJob: unavailable,
      getApprovedResume: unavailable,
      getMatchResult: unavailable,
      getCandidate: unavailable,
    },
    env("fixture"),
  );
  const db = memoryStore();
  const service = new SubmissionService(db.store, sources);
  await assert.rejects(
    service.submitApplication({ jobId: alpha.job.id }, identity),
    (e: any) => e.code === "MISSING_AUTHORIZATION",
  );
  await assert.rejects(
    service.submitApplication(
      { jobId: alpha.job.id },
      { ...identity, role: "recruiter" },
      token,
    ),
    (e: any) => e.code === "FORBIDDEN",
  );
  const result = await service.submitApplication(
    { jobId: alpha.job.id },
    identity,
    token,
  );
  assert.equal(result.development!.fixtureSet, DEV_FIXTURE_SET);
  assert.deepEqual(Object.values(result.development!.sources), [
    "fixture",
    "fixture",
    "fixture",
    "fixture",
  ]);
  assert.equal(result.candidate.email, alpha.candidate.email);
  const beta = DEVELOPMENT_FIXTURES[1];
  const betaCaller: Caller = { userId: beta.candidate.id, role: "seeker" };
  await assert.rejects(
    service.submitApplication({ jobId: beta.job.id }, betaCaller, token),
    (e: any) => e.code === "COVER_LETTER_REQUIRED",
  );
  await service.submitApplication(
    { jobId: beta.job.id, coverLetter: "Demo letter" },
    betaCaller,
    token,
  );
  await assert.rejects(
    service.submitApplication({ jobId: "job_unknown" }, identity, token),
    (e: any) => e.code === "DEV_FIXTURE_NOT_FOUND",
  );
  await assert.rejects(
    service.submitApplication({ jobId: alpha.job.id }, betaCaller, token),
    (e: any) => e.code === "DEV_FIXTURE_NOT_FOUND",
  );
  assert.equal(db.saved.length, 2);
});

test("fallback replaces each actual gRPC/HTTP availability failure independently and recovers to live", async () => {
  const f = await startFixtures(alpha.candidate.id, alpha.job.id);
  const clients = new UpstreamClients({ ...f.config, timeoutMs: 100 });
  const sources = withDevelopmentSources(clients, env("fallback"));
  try {
    for (const source of [
      "jobPosting",
      "resumePreparation",
      "jobDiscovery",
      "candidateProfile",
    ] as const) {
      if (source === "jobPosting") f.state.jobError = grpc.status.UNAVAILABLE;
      if (source === "resumePreparation")
        f.state.resumeError = grpc.status.DEADLINE_EXCEEDED;
      if (source === "jobDiscovery") f.state.slowMatch = true;
      if (source === "candidateProfile") f.state.slowProfile = true;
      const db = memoryStore();
      const application = await new SubmissionService(
        db.store,
        sources,
      ).submitApplication({ jobId: alpha.job.id }, identity, token);
      assert.equal(application.development!.fixtureSet, DEV_FIXTURE_SET);
      for (const [key, value] of Object.entries(
        application.development!.sources,
      ))
        assert.equal(value, key === source ? "fixture" : "live");
      f.state.jobError = 0;
      f.state.resumeError = 0;
      f.state.slowMatch = false;
      f.state.slowProfile = false;
      const recovered = await new SubmissionService(
        memoryStore().store,
        sources,
      ).submitApplication({ jobId: alpha.job.id }, identity, token);
      assert.equal(recovered.development!.fixtureSet, null);
      assert.deepEqual(Object.values(recovered.development!.sources), [
        "live",
        "live",
        "live",
        "live",
      ]);
      assert.equal(application.development!.sources[source], "fixture");
    }
    // Explicit per-service live mode still rejects that service's outage.
    f.state.jobError = grpc.status.UNAVAILABLE;
    await assert.rejects(
      new SubmissionService(
        memoryStore().store,
        withDevelopmentSources(clients, {
          ...env("fallback"),
          JOB_POSTING_MODE: "live",
        }),
      ).submitApplication({ jobId: alpha.job.id }, identity, token),
      UpstreamUnavailableError,
    );
  } finally {
    clients.close();
    await f.close();
  }
});

test("connection-refused fallbacks work together and unknown demo pairs preserve the original failure", async () => {
  const port = await closedPort();
  const clients = new UpstreamClients({
    jobPostingTarget: `127.0.0.1:${port}`,
    resumeTarget: `127.0.0.1:${port}`,
    discoveryUrl: `http://127.0.0.1:${port}`,
    profileUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 100,
    grpcTls: false,
  });
  try {
    const sources = withDevelopmentSources(clients, env("fallback"));
    const result = await new SubmissionService(
      memoryStore().store,
      sources,
    ).submitApplication({ jobId: alpha.job.id }, identity, token);
    assert.deepEqual(Object.values(result.development!.sources), [
      "fixture",
      "fixture",
      "fixture",
      "fixture",
    ]);
    const db = memoryStore();
    await assert.rejects(
      new SubmissionService(db.store, sources).submitApplication(
        { jobId: "job_unknown" },
        identity,
        token,
      ),
      UpstreamUnavailableError,
    );
    await assert.rejects(
      new SubmissionService(db.store, sources).submitApplication(
        { jobId: alpha.job.id },
        { ...identity, userId: DEVELOPMENT_FIXTURES[1].candidate.id },
        token,
      ),
      UpstreamUnavailableError,
    );
    assert.equal(db.saved.length, 0);
    const misconfigured = new UpstreamClients({
      jobPostingTarget: `127.0.0.1:${port}`,
      resumeTarget: `127.0.0.1:${port}`,
      discoveryUrl: `http://127.0.0.1:${port}`,
      profileUrl: "http://127.0.0.1:1",
      timeoutMs: 100,
      grpcTls: false,
    });
    try {
      await assert.rejects(
        new SubmissionService(
          db.store,
          withDevelopmentSources(misconfigured, env("fallback")),
        ).submitApplication({ jobId: alpha.job.id }, identity, token),
        (error: any) => error.code === "UPSTREAM_ERROR",
      );
      assert.equal(db.saved.length, 0);
    } finally {
      misconfigured.close();
    }
  } finally {
    clients.close();
  }
});

test("fallback preserves business, authentication, explicit HTTP errors and malformed responses without writes", async () => {
  const f = await startFixtures(alpha.candidate.id, alpha.job.id);
  const clients = new UpstreamClients({ ...f.config, timeoutMs: 100 });
  const db = memoryStore();
  const service = new SubmissionService(
    db.store,
    withDevelopmentSources(clients, env("fallback")),
  );
  const attempt = (code: string) =>
    assert.rejects(
      service.submitApplication({ jobId: alpha.job.id }, identity, token),
      (e: any) => e.code === code,
    );
  try {
    f.state.status = "JOB_STATUS_CLOSED";
    await attempt("JOB_NOT_OPEN");
    f.state.status = "JOB_STATUS_OPEN";
    f.state.deadline = "2020-01-01T00:00:00Z";
    await attempt("APPLICATION_DEADLINE_PASSED");
    f.state.deadline = "";
    for (const [status, code] of [
      [grpc.status.NOT_FOUND, "JOB_NOT_FOUND"],
      [grpc.status.PERMISSION_DENIED, "FORBIDDEN"],
      [grpc.status.UNAUTHENTICATED, "UPSTREAM_UNAUTHENTICATED"],
    ] as const) {
      f.state.jobError = status;
      await attempt(code);
    }
    f.state.jobError = 0;
    for (const [status, code] of [
      [grpc.status.FAILED_PRECONDITION, "RESUME_NOT_APPROVED"],
      [grpc.status.NOT_FOUND, "RESUME_DRAFT_NOT_FOUND"],
      [grpc.status.INTERNAL, "UPSTREAM_ERROR"],
    ] as const) {
      f.state.resumeError = status;
      await attempt(code);
    }
    f.state.resumeError = 0;
    f.state.malformedResume = true;
    await attempt("UPSTREAM_RESPONSE_INVALID");
    f.state.malformedResume = false;
    for (const field of ["discoveryStatus", "profileStatus"] as const) {
      for (const [status, code] of [
        [401, "UPSTREAM_UNAUTHENTICATED"],
        [403, "FORBIDDEN"],
        [429, "SERVICE_UNAVAILABLE"],
        [503, "SERVICE_UNAVAILABLE"],
        [504, "SERVICE_UNAVAILABLE"],
        [500, "UPSTREAM_ERROR"],
        [302, "UPSTREAM_ERROR"],
      ] as const) {
        f.state[field] = status;
        await attempt(code);
      }
      f.state[field] = 404;
      await attempt(
        field === "profileStatus" ? "PROFILE_REQUIRED" : "JOB_NOT_FOUND",
      );
      f.state[field] = 200;
    }
    f.state.malformedMatch = true;
    await attempt("UPSTREAM_RESPONSE_INVALID");
    f.state.malformedMatch = false;
    f.state.match.candidateId = DEVELOPMENT_FIXTURES[1].candidate.id;
    await attempt("UPSTREAM_RESPONSE_INVALID");
    f.state.match.candidateId = alpha.candidate.id;
    f.state.profile.email = "invalid";
    await attempt("PROFILE_INCOMPLETE");
    assert.equal(db.saved.length, 0);
  } finally {
    clients.close();
    await f.close();
  }
});

test("concurrent requests keep separate provenance and strict-live submissions have no dev labels", async () => {
  const live = fixtureSources();
  live.getJob = async (_id, _caller, authorization) => {
    await new Promise((resolve) =>
      setTimeout(resolve, authorization === "Bearer fixture" ? 5 : 15),
    );
    if (authorization === "Bearer fixture")
      throw new UpstreamUnavailableError("Job Posting");
    return structuredClone(alpha.job);
  };
  const db = memoryStore();
  const service = new SubmissionService(
    db.store,
    withDevelopmentSources(live, env("fallback")),
  );
  const [fallback, real] = await Promise.all([
    service.submitApplication(
      { jobId: alpha.job.id },
      identity,
      "Bearer fixture",
    ),
    service.submitApplication({ jobId: alpha.job.id }, identity, "Bearer live"),
  ]);
  assert.equal(fallback.development!.sources.jobPosting, "fixture");
  assert.equal(real.development!.sources.jobPosting, "live");
  assert.equal(real.development!.fixtureSet, null);
  const strict = await new SubmissionService(
    memoryStore().store,
    withDevelopmentSources(live, env("live")),
  ).submitApplication({ jobId: alpha.job.id }, identity, "Bearer live");
  assert.equal(strict.development, null);
});
