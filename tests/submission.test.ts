import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { createApp } from "../src/app";
import {
  AppError,
  type Application,
  type ApplicationStore,
  type Caller,
} from "../src/repository";
import {
  SubmissionService,
  parseSubmission,
  validateMatch,
  validateResume,
  type SubmissionData,
} from "../src/submission";
import { UpstreamClients } from "../src/upstreams";
import { startFixtures } from "../scripts/submission-fixtures";
const candidateId = randomUUID();
const caller: Caller = { userId: candidateId, role: "seeker" };
const token = "Bearer contract-test-token";
function memoryStore() {
  let saved: Application | undefined;
  let writes = 0;
  const store: ApplicationStore = {
    hasApplication: async () => !!saved,
    submit: async (data: SubmissionData) => {
      writes++;
      const { resumeUpload: _upload, ...snapshot } = structuredClone(data);
      saved = {
        resumeFile: null,
        id: "app_contract",
        candidateId,
        ...snapshot,
        status: "Submitted",
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: [
          {
            status: "Submitted",
            at: new Date().toISOString(),
            changedBy: candidateId,
            note: null,
          },
        ],
      };
      return saved;
    },
    get: async () => saved!,
    getResumeFile: async () => {
      throw new Error("Not exercised");
    },
    mine: async () => (saved ? [saved] : []),
    applicants: async () => [],
    update: async () => {
      throw new Error("Not exercised");
    },
  };
  return { store, writes: () => writes };
}
test("submission validates inputs and roles before any dependency calls", async () => {
  for (const body of [
    null,
    [],
    {},
    { jobId: "bad/id" },
    { jobId: "j", candidateId: "forged" },
    { jobId: "j", candidate: {} },
    { jobId: "j", coverLetter: 3 },
  ])
    assert.throws(
      () => parseSubmission(body),
      (e: any) => e.code === "VALIDATION_ERROR",
    );
  const fixtures = await startFixtures(candidateId, "job_contract");
  const sources = new UpstreamClients(fixtures.config);
  try {
    const db = memoryStore();
    const submit = new SubmissionService(db.store, sources);
    await assert.rejects(
      submit.submitApplication(
        { jobId: "job_contract" },
        { ...caller, role: "recruiter" },
        token,
      ),
      (e: any) => e.httpStatus === 403,
    );
    await assert.rejects(
      submit.submitApplication({ jobId: "job_contract" }, caller),
      (e: any) => e.code === "MISSING_AUTHORIZATION",
    );
    await assert.rejects(
      submit.submitApplication(
        { jobId: "job_contract" },
        { ...caller, userId: "not-a-uuid" },
        token,
      ),
      (e: any) => e.code === "MISSING_IDENTITY",
    );
    assert.equal(fixtures.state.calls.length, 0);
    assert.equal(db.writes(), 0);
  } finally {
    sources.close();
    await fixtures.close();
  }
});
test("actual gRPC/HTTP clients follow contracts, preserve identity, and return immutable submitted snapshots", async () => {
  const fixtures = await startFixtures(candidateId, "job_contract");
  const sources = new UpstreamClients(fixtures.config);
  const db = memoryStore();
  const server = createApp(
    db.store,
    async () => ({ database: true, broker: false }),
    new SubmissionService(db.store, sources),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    "X-User-Id": candidateId,
    "X-User-Role": "seeker",
    Authorization: token,
    "Content-Type": "application/json",
    "X-Company-Id": "forged-company",
  };
  try {
    assert.equal(
      (
        await fetch(origin + "/api/applications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"jobId":"job_contract"}',
        })
      ).status,
      401,
    );
    const response = await fetch(origin + "/api/applications", {
      method: "POST",
      headers,
      body: '{"jobId":"job_contract","coverLetter":"  Cover letter  "}',
    });
    assert.equal(response.status, 201);
    assert.equal(
      response.headers.get("location"),
      "/api/applications/app_contract",
    );
    const { application } = await response.json();
    assert.equal(application.status, "Submitted");
    assert.equal(application.coverLetter, "Cover letter");
    assert.equal(
      application.resumeSnapshot.sections[0].bullets[0].text,
      "Contract test resume",
    );
    assert.equal(application.matchSnapshot.score, 70);
    assert.equal(application.history.length, 1);
    assert.deepEqual(
      fixtures.state.calls.map((x) => x.source),
      ["job", "resume", "match", "profile"],
    );
    for (const call of fixtures.state.calls) {
      assert.equal(call.userId, candidateId);
      assert.equal(call.authorization, token);
      assert.equal(call.companyId, undefined);
    }
    assert.deepEqual(fixtures.state.calls[1].request, {
      candidate_id: candidateId,
      job_id: "job_contract",
    });
    assert.equal(
      fixtures.state.calls[2].request,
      "/api/jobs/job_contract/match",
    );
    const count = fixtures.state.calls.length;
    fixtures.state.resume.sections[0].bullets[0].text = "Edited afterward";
    fixtures.state.match.score = 5;
    const reread = await (
      await fetch(origin + "/api/applications/app_contract", { headers })
    ).json();
    assert.equal(
      reread.application.resumeSnapshot.sections[0].bullets[0].text,
      "Contract test resume",
    );
    assert.equal(reread.application.matchSnapshot.score, 70);
    assert.equal(fixtures.state.calls.length, count);
    assert.equal(
      (
        await fetch(origin + "/api/applications", {
          method: "POST",
          headers,
          body: '{"jobId":"job_contract"}',
        })
      ).status,
      409,
    );
    assert.equal(db.writes(), 1);
    assert.equal(fixtures.state.calls.length, count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sources.close();
    await fixtures.close();
  }
});
test("dependency errors, identity mismatch, invalid payloads and timeouts fail before saving", async () => {
  const f = await startFixtures(candidateId, "job_contract");
  const sources = new UpstreamClients({ ...f.config, timeoutMs: 100 });
  const db = memoryStore();
  const submit = new SubmissionService(db.store, sources);
  const attempt = (code: string) =>
    assert.rejects(
      submit.submitApplication({ jobId: "job_contract" }, caller, token),
      (e: any) =>
        e instanceof AppError &&
        e.code === code &&
        !e.message.includes("Raw provider"),
    );
  try {
    f.state.status = "JOB_STATUS_CLOSED";
    await attempt("JOB_NOT_OPEN");
    f.state.status = "JOB_STATUS_OPEN";
    f.state.deadline = "2020-01-01T00:00:00Z";
    await attempt("APPLICATION_DEADLINE_PASSED");
    f.state.deadline = "";
    f.state.requireCoverLetter = true;
    await attempt("COVER_LETTER_REQUIRED");
    f.state.requireCoverLetter = false;
    f.state.jobError = grpc.status.NOT_FOUND;
    await attempt("JOB_NOT_FOUND");
    f.state.jobError = 0;
    for (const [grpcCode, code] of [
      [grpc.status.NOT_FOUND, "RESUME_DRAFT_NOT_FOUND"],
      [grpc.status.FAILED_PRECONDITION, "RESUME_NOT_APPROVED"],
      [grpc.status.UNAVAILABLE, "SERVICE_UNAVAILABLE"],
      [grpc.status.UNAUTHENTICATED, "UPSTREAM_UNAUTHENTICATED"],
      [grpc.status.INTERNAL, "UPSTREAM_ERROR"],
    ] as const) {
      f.state.resumeError = grpcCode;
      await attempt(code);
    }
    f.state.resumeError = 0;
    f.state.malformedResume = true;
    await attempt("UPSTREAM_RESPONSE_INVALID");
    f.state.malformedResume = false;
    f.state.resume.candidateId = randomUUID();
    await attempt("UPSTREAM_RESPONSE_INVALID");
    f.state.resume.candidateId = candidateId;
    f.state.match.candidateId = randomUUID();
    await attempt("UPSTREAM_RESPONSE_INVALID");
    f.state.match.candidateId = candidateId;
    f.state.match.score = 101;
    await attempt("UPSTREAM_RESPONSE_INVALID");
    f.state.match.score = 70;
    f.state.malformedMatch = true;
    await attempt("UPSTREAM_RESPONSE_INVALID");
    f.state.malformedMatch = false;
    f.state.discoveryStatus = 503;
    await attempt("SERVICE_UNAVAILABLE");
    f.state.discoveryStatus = 200;
    f.state.profileStatus = 404;
    await attempt("PROFILE_REQUIRED");
    f.state.profileStatus = 200;
    f.state.profile.email = "";
    await attempt("PROFILE_INCOMPLETE");
    f.state.profile.email = "contract@example.test";
    f.state.profile.id = randomUUID();
    await attempt("UPSTREAM_RESPONSE_INVALID");
    f.state.profile.id = candidateId;
    f.state.slowMatch = true;
    await attempt("SERVICE_UNAVAILABLE");
    assert.equal(db.writes(), 0);
    assert.equal(
      validateResume({ ...f.state.resume, approvedAt: "bad-date" }),
      false,
    );
    assert.equal(validateMatch({ ...f.state.match, explanation: 123 }), false);
  } finally {
    sources.close();
    await f.close();
  }
});
