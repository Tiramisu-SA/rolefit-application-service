import { test } from "node:test";
import assert from "node:assert/strict";
import * as grpc from "@grpc/grpc-js";
import { loadService, UpstreamClients, sourceConfig } from "../src/upstreams";

const profiles: Record<string, Record<string, string>> = {
  ok: { candidate_id: "ok", name: "Sam", email: "sam@example.test" },
  noemail: { candidate_id: "noemail", name: "Kim", email: "" },
};

async function withClients(fn: (c: UpstreamClients) => Promise<void>) {
  const server = new grpc.Server();
  server.addService(loadService("candidate-profile.proto", "candidateprofile").service, {
    GetProfile: (call: any, cb: any) => {
      const p = profiles[call.request.candidate_id];
      if (!p) return cb({ code: grpc.status.NOT_FOUND, details: "nope" });
      cb(null, { profile: p });
    },
  });
  const port = await new Promise<number>((res, rej) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))),
  );
  const clients = new UpstreamClients({ ...sourceConfig(), candidateProfileTarget: `127.0.0.1:${port}` });
  try {
    await fn(clients);
  } finally {
    clients.close();
    server.forceShutdown();
  }
}

test("reminder recipient comes from Candidate Profile gRPC", async () => {
  await withClients(async (c) => {
    assert.deepEqual(await c.getCandidateForReminder("ok"), { name: "Sam", email: "sam@example.test" });
  });
});

test("missing email or unknown profile throws so the pair is retried later", async () => {
  await withClients(async (c) => {
    await assert.rejects(c.getCandidateForReminder("noemail"));
    await assert.rejects(c.getCandidateForReminder("ghost"));
  });
});

test("unknown profile maps to CANDIDATE_NOT_FOUND, not a resume draft error", async () => {
  await withClients(async (c) => {
    await assert.rejects(
      c.getCandidateForReminder("ghost"),
      (e: any) => e.code === "CANDIDATE_NOT_FOUND",
    );
  });
});
