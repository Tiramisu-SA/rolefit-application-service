/** Dedicated rolefit-submission-dev stack only. Trusted test headers; simulated upstream data. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import {
  DEVELOPMENT_FIXTURES,
  DEV_FIXTURE_SET,
} from "../src/development-fixtures";
import { validateEvent } from "../src/event";

const compose = ["compose", "-f", "compose.yaml", "-f", "compose.dev.yaml"];
const pool = new Pool({
  connectionString:
    "postgresql://application:application-local@localhost:5433/application_dev",
});
const notificationPool = new Pool({
  connectionString:
    "postgresql://notification:notification-local@localhost:5433/notification_dev",
});
pool.on("error", () => {});
notificationPool.on("error", () => {});
const ownedIds: string[] = [];
const ownedEvents: string[] = [];
const alpha = DEVELOPMENT_FIXTURES[0],
  beta = DEVELOPMENT_FIXTURES[1];
const headers = (id = alpha.candidate.id, companyId?: string) => ({
  "X-User-Id": id,
  "X-User-Role": companyId ? "recruiter" : "seeker",
  "Content-Type": "application/json",
  Authorization: "Bearer local-development-test",
  ...(companyId ? { "X-Company-Id": companyId } : {}),
});
async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`http://localhost:3004${path}`, {
    ...options,
    headers: options.headers || headers(),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (options.method === "POST" && response.status === 201)
    ownedIds.push(body.application.id);
  return { status: response.status, body };
}
async function waitReady() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      if (
        (
          await fetch("http://localhost:3004/ready", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok &&
        (
          await fetch("http://localhost:3005/ready", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        return;
    } catch {}
    await delay(300);
  }
  throw new Error("Development Application/Notification did not become ready");
}
async function main() {
  try {
    const runtime = JSON.parse(
      execFileSync(
        "docker",
        [
          ...compose,
          "exec",
          "-T",
          "application",
          "node",
          "-e",
          'const names=["APP_ENV","UPSTREAM_MODE","JOB_POSTING_MODE","RESUME_PREPARATION_MODE","JOB_DISCOVERY_MODE","CANDIDATE_PROFILE_MODE","JOB_POSTING_GRPC_URL","RESUME_PREPARATION_GRPC_URL","JOB_DISCOVERY_SERVICE_URL","CANDIDATE_PROFILE_SERVICE_URL"];console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,process.env[n]]))))',
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(runtime.APP_ENV, "development");
    for (const key of [
      "JOB_POSTING_MODE",
      "RESUME_PREPARATION_MODE",
      "JOB_DISCOVERY_MODE",
      "CANDIDATE_PROFILE_MODE",
    ])
      assert.equal(
        runtime[key],
        "fallback",
        "Use the documented controlled fallback test configuration",
      );
    for (const key of ["JOB_POSTING_GRPC_URL", "RESUME_PREPARATION_GRPC_URL"])
      assert.equal(runtime[key], "host.docker.internal:59999");
    for (const key of [
      "JOB_DISCOVERY_SERVICE_URL",
      "CANDIDATE_PROFILE_SERVICE_URL",
    ])
      assert.equal(runtime[key], "http://host.docker.internal:59999");
    assert.equal(
      (await pool.query("SELECT current_database() AS name")).rows[0].name,
      "application_dev",
    );
    assert.equal(
      (await notificationPool.query("SELECT current_database() AS name"))
        .rows[0].name,
      "notification_dev",
    );
    const existing = await pool.query(
      "SELECT id FROM applications WHERE (candidate_id=$1 AND job_id=$2) OR (candidate_id=$3 AND job_id=$4)",
      [alpha.candidate.id, alpha.job.id, beta.candidate.id, beta.job.id],
    );
    assert.equal(
      existing.rowCount,
      0,
      "Existing demo applications are preserved; use an unused development test stack",
    );
    await waitReady();
    const missing = await request("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: alpha.job.id }),
    });
    assert.equal(missing.status, 401);
    const unknown = await request("/api/applications", {
      method: "POST",
      body: '{"jobId":"job_unknown"}',
    });
    assert.equal(unknown.status, 503);
    assert.equal(unknown.body.error.code, "SERVICE_UNAVAILABLE");
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) AS total FROM applications WHERE candidate_id=$1",
          [alpha.candidate.id],
        )
      ).rows[0].total,
      "0",
    );
    const submitted = await request("/api/applications", {
      method: "POST",
      body: JSON.stringify({ jobId: alpha.job.id }),
    });
    assert.equal(submitted.status, 201);
    const application = submitted.body.application;
    assert.equal(application.development.fixtureSet, DEV_FIXTURE_SET);
    assert.deepEqual(Object.values(application.development.sources), [
      "fixture",
      "fixture",
      "fixture",
      "fixture",
    ]);
    assert.equal(application.candidate.email, alpha.candidate.email);
    assert.equal(application.resumeSnapshot.draftId, alpha.resume.draftId);
    assert.equal(application.matchSnapshot.score, alpha.match.score);
    assert.equal(application.history.length, 1);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) AS total FROM notification_outbox WHERE application_id=$1",
          [application.id],
        )
      ).rows[0].total,
      "0",
    );
    assert.deepEqual(
      (
        await pool.query("SELECT development FROM applications WHERE id=$1", [
          application.id,
        ])
      ).rows[0].development,
      application.development,
    );
    assert.equal(
      (
        await request("/api/applications", {
          method: "POST",
          body: JSON.stringify({ jobId: alpha.job.id }),
        })
      ).body.error.code,
      "ALREADY_APPLIED",
    );
    console.log(
      "PASS controlled four-service outages -> matching fixtures -> real atomic application/history/provenance; no initial event",
    );
    const required = await request("/api/applications", {
      method: "POST",
      headers: headers(beta.candidate.id),
      body: JSON.stringify({ jobId: beta.job.id }),
    });
    assert.equal(required.body.error.code, "COVER_LETTER_REQUIRED");
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) AS total FROM applications WHERE candidate_id=$1",
          [beta.candidate.id],
        )
      ).rows[0].total,
      "0",
    );
    const covered = await request("/api/applications", {
      method: "POST",
      headers: headers(beta.candidate.id),
      body: JSON.stringify({
        jobId: beta.job.id,
        coverLetter: "Demo cover letter",
      }),
    });
    assert.equal(covered.status, 201);
    assert.equal(covered.body.application.companyId, beta.job.companyId);
    assert.equal(covered.body.application.coverLetter, "Demo cover letter");
    for (const identity of [
      headers(beta.candidate.id),
      headers("demo-recruiter", beta.job.companyId),
    ]) {
      assert.equal(
        (
          await request(`/api/applications/${application.id}`, {
            headers: identity,
          })
        ).status,
        403,
      );
    }
    const mine = await request("/api/applications/mine");
    assert.equal(mine.body.applications.length, 1);
    assert.deepEqual(
      mine.body.applications[0].development,
      application.development,
    );
    console.log(
      "PASS fixture requirements, duplicate protection, seeker/company isolation and list provenance",
    );
    execFileSync(
      "docker",
      [...compose, "restart", "application", "notification"],
      { stdio: "pipe", timeout: 30000 },
    );
    await waitReady();
    const reread = await request(`/api/applications/${application.id}`);
    assert.equal(reread.status, 200);
    assert.deepEqual(reread.body.application, application);
    console.log(
      "PASS Application/Notification restart preserves immutable snapshots and development source labels",
    );
    const updated = await request(
      `/api/applications/${application.id}/status`,
      {
        method: "PATCH",
        headers: headers("demo-recruiter", alpha.job.companyId),
        body: '{"status":"Interview"}',
      },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.notificationQueued, true);
    assert.deepEqual(
      updated.body.application.development,
      application.development,
    );
    const event = (
      await pool.query(
        "SELECT event_id,payload FROM notification_outbox WHERE application_id=$1",
        [application.id],
      )
    ).rows[0];
    ownedEvents.push(event.event_id);
    assert.ok(validateEvent(event.payload));
    assert.equal(event.payload.development, undefined);
    assert.equal(event.payload.recipient.email, alpha.candidate.email);
    const deadline = Date.now() + 30000;
    let sent = false;
    while (Date.now() < deadline) {
      sent = !!(
        await notificationPool.query(
          "SELECT 1 FROM notification_deliveries WHERE event_id=$1 AND status='sent'",
          [event.event_id],
        )
      ).rowCount;
      if (sent) break;
      await delay(250);
    }
    assert.equal(sent, true);
    const messages = await (
      await fetch("http://localhost:8025/api/v1/messages?limit=100")
    ).json();
    let captured = false;
    for (const message of messages.messages || []) {
      const detail = await (
        await fetch(`http://localhost:8025/api/v1/message/${message.ID}`)
      ).json();
      if (JSON.stringify(detail).includes(event.event_id)) {
        captured = true;
        assert.ok(JSON.stringify(detail).includes("Interview"));
        assert.ok(JSON.stringify(detail).includes(alpha.candidate.email));
      }
    }
    assert.ok(captured);
    console.log(
      "PASS simulated submission -> real status outbox -> RabbitMQ -> Notification -> Mailpit email; event schema unchanged",
    );
    console.log(
      "ALL DEVELOPMENT INTEGRATION CHECKS PASSED (isolated real storage/broker/SMTP; upstream fixtures; gateway/JWT not exercised)",
    );
  } finally {
    if (ownedIds.length) {
      // Delete only IDs returned from this run, never existing user-created demo applications.
      const events = await pool.query(
        "SELECT event_id FROM notification_outbox WHERE application_id=ANY($1::text[])",
        [ownedIds],
      );
      const eventIds = [
        ...new Set([...ownedEvents, ...events.rows.map((x) => x.event_id)]),
      ];
      await notificationPool.query(
        "DELETE FROM notification_deliveries WHERE event_id=ANY($1::uuid[])",
        [eventIds],
      );
      await pool.query(
        "DELETE FROM notification_outbox WHERE application_id=ANY($1::text[])",
        [ownedIds],
      );
      await pool.query(
        "DELETE FROM application_status_history WHERE application_id=ANY($1::text[])",
        [ownedIds],
      );
      await pool.query("DELETE FROM applications WHERE id=ANY($1::text[])", [
        ownedIds,
      ]);
    }
    await pool.end();
    await notificationPool.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
