import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createApp } from "../src/app";
import { logger } from "../src/logger";
import { publishNext } from "../src/outbox";
import { runWithRequestId } from "../src/request-context";
import {
  AppError,
  Repository,
  type Application,
  type ApplicationStore,
  type Caller,
} from "../src/repository";
import { SubmissionService, type SubmissionData } from "../src/submission";
import { UpstreamClients } from "../src/upstreams";
import { startFixtures } from "../scripts/submission-fixtures";
import { withCapturedLogs } from "./capture-logs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const seeker = { "X-User-Id": "u", "X-User-Role": "seeker" };
const recruiter = {
  "X-User-Id": "r",
  "X-User-Role": "recruiter",
  "X-Company-Id": "co",
};

const baseStore: ApplicationStore = {
  hasApplication: async () => false,
  submit: async () => {
    throw new Error("Not exercised");
  },
  get: async () => {
    throw new AppError(404, "APPLICATION_NOT_FOUND", "Application not found");
  },
  mine: async () => [],
  applicants: async () => [],
  update: async () => {
    throw new Error("Not exercised");
  },
};

async function withApi(
  fn: (base: string) => Promise<void>,
  store: ApplicationStore = baseStore,
  submission?: SubmissionService,
) {
  const server = createApp(
    store,
    async () => ({ database: true, broker: true }),
    submission,
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a request logs one JSON line with its id, method, path without query, status and duration", async () => {
  await withCapturedLogs(async (logs) => {
    await withApi(async (base) => {
      const res = await fetch(`${base}/api/applications/mine?x=private`, {
        headers: { ...seeker, "X-Request-Id": "req-abc_1.2" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-request-id"), "req-abc_1.2");

      const line = await logs.waitFor((l) => l.requestId === "req-abc_1.2");
      assert.equal(line.service, "application");
      assert.equal(line.level, "info");
      assert.equal(line.method, "GET");
      assert.equal(line.path, "/api/applications/mine");
      assert.equal(line.status, 200);
      assert.equal(typeof line.durationMs, "number");
    });
  });
});

test("a missing or unsafe incoming id is replaced with a generated one", async () => {
  await withCapturedLogs(async (logs) => {
    await withApi(async (base) => {
      for (const incoming of [undefined, "has spaces", "x".repeat(129)]) {
        const res = await fetch(`${base}/api/applications/mine`, {
          headers: {
            ...seeker,
            ...(incoming ? { "X-Request-Id": incoming } : {}),
          },
        });
        const id = res.headers.get("x-request-id") ?? "";
        assert.match(id, UUID, `incoming: ${incoming}`);
        await logs.waitFor((l) => l.requestId === id);
      }
    });
  });
});

test("health and readiness checks are not logged, so polling does not bury real requests", async () => {
  await withCapturedLogs(async (logs) => {
    await withApi(async (base) => {
      await fetch(`${base}/health`);
      await fetch(`${base}/ready`);
      await fetch(`${base}/api/applications/mine`, { headers: seeker });
      await logs.waitFor((l) => l.path === "/api/applications/mine");
      const noise = logs
        .lines()
        .filter((l) => l.path === "/health" || l.path === "/ready");
      assert.equal(noise.length, 0);
    });
  });
});

test("a malformed JSON body is logged with the request id", async () => {
  await withCapturedLogs(async (logs) => {
    await withApi(async (base) => {
      const res = await fetch(`${base}/api/applications/a1/status`, {
        method: "PATCH",
        headers: {
          ...recruiter,
          "Content-Type": "application/json",
          "X-Request-Id": "req-bad-json",
        },
        body: "{not json",
      });
      assert.equal(res.status, 400);
      assert.equal(
        (await logs.waitFor((l) => l.requestId === "req-bad-json")).status,
        400,
      );
    });
  });
});

// The JSON body parser reads the request stream, and its callbacks can run outside the async context of the request.
test("a storage failure after a JSON body is parsed is logged with the request id", async () => {
  await withCapturedLogs(async (logs) => {
    await withApi(
      async (base) => {
        const res = await fetch(`${base}/api/applications/a1/status`, {
          method: "PATCH",
          headers: {
            ...recruiter,
            "Content-Type": "application/json",
            "X-Request-Id": "req-json",
          },
          body: JSON.stringify({ status: "Offer" }),
        });
        assert.equal(res.status, 503);
        const line = await logs.waitFor(
          (l) => l.message === "Application operation failed",
        );
        assert.equal(line.requestId, "req-json");
        assert.equal(line.level, "error");
      },
      {
        ...baseStore,
        update: async () => {
          throw new Error("password=secret host=db");
        },
      },
    );
  });
});

test("overlapping requests keep their own ids in error logs, and raw storage errors stay out of the logs", async () => {
  await withCapturedLogs(async (logs) => {
    await withApi(
      async (base) => {
        const get = (job: string) =>
          fetch(`${base}/api/applications?jobId=${job}`, {
            headers: { ...recruiter, "X-Request-Id": `req-${job}` },
          });
        await Promise.all([get("slow"), get("fast")]);
        await logs.waitFor((l) => l.requestId === "req-slow" && l.level === "error");
        await logs.waitFor((l) => l.requestId === "req-fast" && l.level === "error");
        assert.ok(
          !JSON.stringify(logs.lines()).includes("password=secret"),
          "the raw storage error must not be logged",
        );
      },
      {
        ...baseStore,
        applicants: async (jobId) => {
          await new Promise((resolve) =>
            setTimeout(resolve, jobId === "slow" ? 40 : 5),
          );
          throw new Error("password=secret host=db");
        },
      },
    );
  });
});

test("submitting an application forwards the id to all four upstream calls", async () => {
  const candidateId = randomUUID();
  const fixtures = await startFixtures(candidateId, "job_trace");
  const sources = new UpstreamClients(fixtures.config);
  const store: ApplicationStore = {
    ...baseStore,
    submit: async (data: SubmissionData) =>
      ({
        id: "app_trace",
        candidateId,
        ...data,
        status: "Submitted",
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: [],
      }) as unknown as Application,
  };
  try {
    await withCapturedLogs(async () => {
      await withApi(
        async (base) => {
          const res = await fetch(`${base}/api/applications`, {
            method: "POST",
            headers: {
              "X-User-Id": candidateId,
              "X-User-Role": "seeker",
              Authorization: "Bearer token",
              "Content-Type": "application/json",
              "X-Request-Id": "req-submit",
            },
            body: JSON.stringify({ jobId: "job_trace" }),
          });
          assert.equal(res.status, 201);
        },
        store,
        new SubmissionService(store, sources),
      );
    });
    assert.deepEqual(
      fixtures.state.calls.map((call) => [call.source, call.requestId]),
      [
        ["job", "req-submit"],
        ["resume", "req-submit"],
        ["match", "req-submit"],
        ["profile", "req-submit"],
      ],
    );
  } finally {
    sources.close();
    await fixtures.close();
  }
});

test("an unreachable gRPC or HTTP upstream is logged with the request id and its name", async () => {
  const caller: Caller = { userId: "u", role: "seeker" };
  // A port that was just open and is now closed. fetch refuses low ports like 1 outright.
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const closed = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const sources = new UpstreamClients({
    jobPostingTarget: `127.0.0.1:${closed}`,
    resumeTarget: `127.0.0.1:${closed}`,
    discoveryUrl: `http://127.0.0.1:${closed}`,
    profileUrl: `http://127.0.0.1:${closed}`,
    timeoutMs: 1000,
    grpcTls: false,
  });
  try {
    await withCapturedLogs(async (logs) => {
      await runWithRequestId("req-grpc-down", () =>
        assert.rejects(sources.getJob("job", caller, "Bearer t")),
      );
      const grpcLine = await logs.waitFor(
        (l) => l.requestId === "req-grpc-down",
      );
      assert.equal(grpcLine.upstream, "Job Posting");
      assert.equal(grpcLine.level, "error");

      await runWithRequestId("req-http-down", () =>
        assert.rejects(sources.getCandidate(caller, "Bearer t")),
      );
      const httpLine = await logs.waitFor(
        (l) => l.requestId === "req-http-down",
      );
      assert.equal(httpLine.upstream, "Candidate Profile");
    });
  } finally {
    sources.close();
  }
});

function fakeRepositoryPool() {
  const row = {
    id: "a1",
    job_id: "j1",
    company_id: "co",
    candidate_id: "u1",
    candidate: { id: "u1", name: "Pim", email: "pim@example.test" },
    job_snapshot: { title: "Developer" },
    status: "Submitted",
    submitted_at: new Date(),
    updated_at: new Date(),
    history_rows: [],
  };
  const queries: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.startsWith("SELECT * FROM applications")) return { rows: [row] };
      if (sql.startsWith("UPDATE applications"))
        return { rows: [{ ...row, status: params[1] }] };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client }, queries };
}

const recruiterCaller: Caller = {
  userId: "r",
  role: "recruiter",
  companyId: "co",
};
const outboxInsert = (queries: { sql: string; params: unknown[] }[]) =>
  queries.find((q) => q.sql.startsWith("INSERT INTO notification_outbox"))!;

test("a status change stores the request id with its outbox event, outside the event payload", async () => {
  const { pool, queries } = fakeRepositoryPool();
  await runWithRequestId("req-outbox", () =>
    new Repository(pool as never).update(
      "a1",
      "Offer",
      undefined,
      recruiterCaller,
    ),
  );
  const insert = outboxInsert(queries);
  assert.match(insert.sql, /request_id/);
  assert.equal(insert.params[3], "req-outbox");
  assert.ok(
    !("requestId" in (insert.params[2] as object)),
    "the event contract forbids extra fields",
  );
});

test("a status change outside a request stores no request id", async () => {
  const { pool, queries } = fakeRepositoryPool();
  await new Repository(pool as never).update(
    "a1",
    "Offer",
    undefined,
    recruiterCaller,
  );
  assert.equal(outboxInsert(queries).params[3], null);
});

function fakeOutbox(requestId: string | null) {
  const eventId = randomUUID();
  const payload = { eventId, newStatus: "Offer" };
  const client = {
    query: async (sql: string) =>
      sql.startsWith("SELECT")
        ? { rows: [{ event_id: eventId, payload, request_id: requestId }] }
        : { rows: [] },
    release: () => {},
  };
  const published: {
    options: Record<string, unknown>;
    payload: Buffer;
  }[] = [];
  const channel = {
    on: () => {},
    off: () => {},
    publish: (
      _exchange: string,
      _key: string,
      body: Buffer,
      options: Record<string, unknown>,
      callback: (error: Error | null) => void,
    ) => {
      published.push({ options, payload: body });
      callback(null);
    },
  };
  return {
    eventId,
    payload,
    published,
    pool: { connect: async () => client } as never,
    broker: {
      ready: true,
      channel,
      disconnect: async () => {},
    } as never,
  };
}

test("the outbox worker publishes the stored id as the AMQP correlation id and logs it", async () => {
  const outbox = fakeOutbox("req-outbox");
  await withCapturedLogs(async (logs) => {
    assert.equal(await publishNext(outbox.pool, outbox.broker), true);
    const line = await logs.waitFor((l) => l.message === "event published");
    assert.equal(line.requestId, "req-outbox");
    assert.equal(line.eventId, outbox.eventId);
  });
  assert.equal(outbox.published[0].options.correlationId, "req-outbox");
  assert.equal(outbox.published[0].options.messageId, outbox.eventId);
  assert.deepEqual(
    JSON.parse(outbox.published[0].payload.toString("utf8")),
    outbox.payload,
  );
});

test("an event stored before this change is still published, without a correlation id", async () => {
  const outbox = fakeOutbox(null);
  await withCapturedLogs(async () => {
    assert.equal(await publishNext(outbox.pool, outbox.broker), true);
  });
  assert.equal(outbox.published[0].options.correlationId, undefined);
});

test("the logger writes an Error as JSON and survives values JSON cannot represent", async () => {
  await withCapturedLogs(async (logs) => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.error("It failed", new TypeError("bad input"));
    logger.error("Circular detail", circular);
    const error = (await logs.waitFor((l) => l.message === "It failed"))
      .error as { name: string; message: string };
    assert.equal(error.name, "TypeError");
    assert.equal(error.message, "bad input");
    await logs.waitFor((l) => l.message === "Circular detail");
  });
});
