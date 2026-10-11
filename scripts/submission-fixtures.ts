/** Local contract stubs only. These are not teammates' implementations or real JWT verification. */
import * as grpc from "@grpc/grpc-js";
import { createServer } from "node:http";
import { once } from "node:events";
import { loadService, type SourceConfig } from "../src/upstreams";
import type { ApprovedResume, MatchResult } from "../src/submission";
export async function startFixtures(candidateId: string, jobId: string) {
  const at = new Date().toISOString();
  const resume: ApprovedResume = {
    draftId: "draft_contract_test",
    candidateId,
    jobId,
    format: "personal",
    approvedAt: at,
    updatedAt: at,
    sections: [
      {
        id: "summary",
        kind: "summary",
        title: "Summary",
        meta: "",
        emphasized: false,
        bullets: [
          { id: "summary-0", text: "Contract test resume", tailored: false },
        ],
      },
    ],
  };
  const match: MatchResult = {
    candidateId,
    jobId,
    score: 70,
    breakdown: { skills: 50, experience: 100, education: 50, preferences: 100 },
    matchedSkills: ["React"],
    missingSkills: ["TypeScript"],
    strengths: ["React experience"],
    gaps: ["TypeScript"],
    explanation: "Illustrative contract test match",
    computedAt: at,
  };
  const state = {
    status: "JOB_STATUS_OPEN",
    deadline: "",
    requireCoverLetter: false,
    resume,
    match,
    profile: {
      id: candidateId,
      name: "Contract <candidate>",
      email: "contract@example.test",
    },
    resumeError: 0,
    jobError: 0,
    discoveryStatus: 200,
    profileStatus: 200,
    malformedMatch: false,
    slowMatch: false,
    malformedResume: false,
    calls: [] as {
      source: string;
      request: unknown;
      userId: string;
      role: string;
      authorization: string;
      companyId?: string;
    }[],
  };
  const servers: grpc.Server[] = [];
  async function grpcServer(
    file: string,
    namespace: "jobposting" | "resumepreparation",
    handler: grpc.UntypedServiceImplementation,
  ) {
    const server = new grpc.Server();
    servers.push(server);
    server.addService(loadService(file, namespace).service, handler);
    return new Promise<number>((resolve, reject) =>
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (err, port) => (err ? reject(err) : resolve(port)),
      ),
    );
  }
  const record = (source: string, call: grpc.ServerUnaryCall<any, any>) =>
    state.calls.push({
      source,
      request: call.request,
      userId: String(call.metadata.get("x-user-id")[0] || ""),
      role: String(call.metadata.get("x-user-role")[0] || ""),
      authorization: String(call.metadata.get("authorization")[0] || ""),
      companyId: call.metadata.get("x-company-id")[0] as string | undefined,
    });
  const jobPort = await grpcServer("job-posting.proto", "jobposting", {
    GetJob(
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) {
      record("job", call);
      if (state.jobError)
        return callback({
          code: state.jobError,
          details: "Raw provider details must not leak",
        });
      callback(null, {
        job: {
          id: call.request.job_id,
          title: "Contract <job>",
          company_id: "co-contract",
          status: state.status,
          application_settings: {
            application_deadline: state.deadline,
            require_cover_letter: state.requireCoverLetter,
          },
        },
      });
    },
  });
  const resumePort = await grpcServer(
    "resume-preparation.proto",
    "resumepreparation",
    {
      GetApprovedResume(
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) {
        record("resume", call);
        if (state.resumeError)
          return callback({
            code: state.resumeError,
            details: "Raw provider details must not leak",
          });
        callback(null, {
          resume: {
            draft_id: state.resume.draftId,
            candidate_id: state.resume.candidateId,
            job_id: state.resume.jobId,
            format: "RESUME_FORMAT_PERSONAL",
            sections: state.malformedResume ? [] : state.resume.sections,
            approved_at: state.resume.approvedAt,
            updated_at: state.resume.updatedAt,
          },
        });
      },
    },
  );
  const http = createServer((req, res) => {
    const source = req.url === "/api/profiles/me" ? "profile" : "match";
    state.calls.push({
      source,
      request: req.url,
      userId: String(req.headers["x-user-id"] || ""),
      role: String(req.headers["x-user-role"] || ""),
      authorization: String(req.headers.authorization || ""),
      companyId: req.headers["x-company-id"] as string | undefined,
    });
    const send = () => {
      res.setHeader("Content-Type", "application/json");
      res.statusCode =
        source === "profile" ? state.profileStatus : state.discoveryStatus;
      if (source === "match" && state.malformedMatch) return res.end("{");
      res.end(
        JSON.stringify(source === "profile" ? state.profile : state.match),
      );
    };
    if (source === "match" && state.slowMatch) {
      const timer = setTimeout(send, 500);
      timer.unref();
    } else send();
  }).listen(0, "127.0.0.1");
  await once(http, "listening");
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const config: SourceConfig = {
    jobPostingTarget: `127.0.0.1:${jobPort}`,
    resumeTarget: `127.0.0.1:${resumePort}`,
    discoveryUrl: origin,
    profileUrl: origin,
    timeoutMs: 1000,
    grpcTls: false,
  };
  return {
    state,
    config,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      for (const server of servers) server.forceShutdown();
    },
  };
}
