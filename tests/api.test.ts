import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/app";
import { AppError, type ApplicationStore } from "../src/repository";
import { validateEvent } from "../src/event";
import { databaseConfig } from "../src/config";
const calls: unknown[] = [];
const store: ApplicationStore = {
  get: async () => {
    throw new AppError(404, "APPLICATION_NOT_FOUND", "Application not found");
  },
  mine: async (caller) => {
    calls.push(caller);
    return [];
  },
  applicants: async () => [],
  update: async () => {
    throw new Error("Should not reach storage");
  },
};
test("HTTP contract rejects missing/unknown identity and invalid update input", async () => {
  const server = createApp(store, async () => ({
    database: true,
    broker: false,
  })).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(url + "/health")).status, 200);
    const ready = await fetch(url + "/ready");
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).status, "degraded");
    assert.equal((await fetch(url + "/api/applications/mine")).status, 401);
    assert.equal(
      (
        await fetch(url + "/api/applications/mine", {
          headers: { "X-User-Id": "u", "X-User-Role": "admin" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/api/applications/mine", {
          headers: { "X-User-Id": "u", "X-User-Role": "recruiter" },
        })
      ).status,
      401,
    );
    const seeker = { "X-User-Id": "u", "X-User-Role": "seeker" };
    assert.equal(
      (await fetch(url + "/api/applications/mine", { headers: seeker })).status,
      200,
    );
    assert.equal((calls[0] as any).userId, "u");
    assert.equal(
      (
        await fetch(url + "/api/applications/a/status", {
          method: "PATCH",
          headers: { ...seeker, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "Offer" }),
        })
      ).status,
      403,
    );
    const recruiter = {
      "X-User-Id": "r",
      "X-User-Role": "recruiter",
      "X-Company-Id": "co",
      "Content-Type": "application/json",
    };
    for (const body of [
      { status: "Hired" },
      { status: "Offer", candidateId: "forged" },
      { status: "Offer", note: 3 },
      [],
    ])
      assert.equal(
        (
          await fetch(url + "/api/applications/a/status", {
            method: "PATCH",
            headers: recruiter,
            body: JSON.stringify(body),
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await fetch(url + "/api/applications/a/status", {
          method: "PATCH",
          headers: recruiter,
          body: "{",
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(url + "/api/applications", { headers: recruiter })).status,
      400,
    );
    const missing = await fetch(url + "/api/applications/nope", {
      headers: seeker,
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: {
        code: "APPLICATION_NOT_FOUND",
        message: "Application not found",
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("event schema rejects private extra data and malformed recipients", () => {
  const event = {
    eventId: "26ec5af5-7cef-434b-9fe9-dc4f37e00455",
    schemaVersion: 1,
    eventType: "application.status.changed.v1",
    occurredAt: "2026-10-11T00:00:00Z",
    applicationId: "a",
    jobId: "j",
    candidateId: "u",
    recipient: { name: "Sample", email: "sample@example.test" },
    jobTitle: "Sample",
    previousStatus: "Submitted",
    newStatus: "Offer",
  };
  assert.equal(validateEvent(event), true);
  assert.equal(
    validateEvent({ ...event, note: "private recruiter note" }),
    false,
  );
  assert.equal(
    validateEvent({ ...event, recipient: { name: "Sample", email: "bad" } }),
    false,
  );
  assert.equal(validateEvent({ ...event, schemaVersion: 2 }), false);
});
test("hosted database TLS keeps certificate verification enabled", () => {
  const config = databaseConfig(
    "postgresql://user:password@example.test/db?sslmode=require",
  );
  assert.equal(
    (config.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized,
    true,
  );
  assert.equal(
    new URL(config.connectionString!).searchParams.has("sslmode"),
    false,
  );
});
