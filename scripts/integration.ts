/** Real local dependency checks. Trusted headers here do NOT test gateway JWT authentication.
 * Uses only uniquely named fixtures in this dedicated Compose stack. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import amqp from "amqplib";
import {
  topology,
  publishConfirmed,
  EXCHANGE,
  KEY,
  QUEUE,
  DEAD_QUEUE,
} from "../src/broker";
import { validateEvent } from "../src/event";
import { seed } from "../src/seed";
const {
  deliverNext,
} = require("../../rolefit-notification-service/src/delivery");
const appPool = new Pool({
  connectionString:
    "postgresql://application:application-local@localhost:5433/application",
});
const notificationPool = new Pool({
  connectionString:
    "postgresql://notification:notification-local@localhost:5433/notification",
});
appPool.on("error", () => {});
notificationPool.on("error", () => {});
const suffix = randomUUID().replaceAll("-", "");
const id = `app_integration_${suffix}`;
const rollbackId = `app_rollback_${suffix}`;
const company = "co-integration";
const user = `seeker-${suffix}`;
const recipient = `${suffix}@example.test`;
const fixtureIds = [id, rollbackId];
const eventIds: string[] = [];
const headers = {
  "X-User-Id": "recruiter-integration",
  "X-User-Role": "recruiter",
  "X-Company-Id": company,
  "Content-Type": "application/json",
};
const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", ...args], {
    stdio: "pipe",
    timeout: 120000,
  });
async function until(
  fn: () => Promise<boolean>,
  message: string,
  timeout = 60000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await delay(500);
  }
  throw new Error(message);
}
async function api(path: string, options: RequestInit = {}) {
  const response = await fetch("http://localhost:3004" + path, {
    ...options,
    headers: options.headers || headers,
  });
  return { status: response.status, body: await response.json() };
}
async function patch(
  status: string,
  target = id,
  extra: Record<string, unknown> = {},
) {
  return api(`/api/applications/${target}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, ...extra }),
  });
}
async function inserted(target: string) {
  await appPool.query(
    `INSERT INTO applications(id,job_id,company_id,candidate_id,candidate,job_snapshot,status) VALUES($1,$6,$2,$3,$4,$5,'Submitted')`,
    [
      target,
      company,
      user,
      { id: user, name: "Sample <candidate>", email: recipient },
      { id: "job-integration", title: "Sample <job>", companyId: company },
      target === rollbackId ? "job-rollback" : "job-integration",
    ],
  );
  await appPool.query(
    "INSERT INTO application_status_history(application_id,status,at,changed_by) VALUES($1,'Submitted',now(),'integration-fixture')",
    [target],
  );
}
async function latestEvent() {
  const { rows } = await appPool.query(
    "SELECT event_id,payload,published_at FROM notification_outbox WHERE application_id=$1 ORDER BY sequence DESC LIMIT 1",
    [id],
  );
  if (!eventIds.includes(rows[0].event_id)) eventIds.push(rows[0].event_id);
  return rows[0];
}
async function sent(eventId: string) {
  return !!(
    await notificationPool.query(
      "SELECT 1 FROM notification_deliveries WHERE event_id=$1 AND status='sent'",
      [eventId],
    )
  ).rowCount;
}
async function mailCount(eventId: string) {
  const list = await (
    await fetch("http://localhost:8025/api/v1/messages?limit=100")
  ).json();
  let count = 0;
  for (const message of list.messages || []) {
    const detail = await (
      await fetch(`http://localhost:8025/api/v1/message/${message.ID}`)
    ).json();
    if (JSON.stringify(detail).includes(eventId)) count++;
  }
  return count;
}
async function main() {
  await until(
    async () => (await fetch("http://localhost:3005/ready")).ok,
    "Services not ready",
  );
  await inserted(id);
  await inserted(rollbackId);
  await appPool.query(
    "UPDATE applications SET resume_reference=$2,match_snapshot=$3 WHERE id=$1",
    [
      id,
      { id: "sample-approved-resume" },
      {
        score: 42,
        summary: "Sample stored match",
        capturedAt: "2026-10-11T00:00:00Z",
      },
    ],
  );
  let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
  try {
    assert.equal(
      (
        await api("/api/applications/mine", {
          headers: { "X-User-Id": user, "X-User-Role": "seeker" },
        })
      ).body.applications.length,
      2,
    );
    assert.equal(
      (await api("/api/applications?jobId=job-integration")).body.applications
        .length,
      1,
    );
    assert.equal(
      (
        await api(`/api/applications/${id}`, {
          headers: { ...headers, "X-Company-Id": "other-company" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await api("/api/applications?jobId=job-integration", {
          headers: { ...headers, "X-Company-Id": "other-company" },
        })
      ).body.applications.length,
      0,
    );
    assert.equal(
      (
        await api(`/api/applications/${id}`, {
          headers: { "X-User-Id": "other-seeker", "X-User-Role": "seeker" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await api(`/api/applications/${id}/status`, {
          method: "PATCH",
          headers: {
            "X-User-Id": user,
            "X-User-Role": "seeker",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "Offer" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (await api("/api/applications/mine", { headers: {} })).status,
      401,
    );
    assert.equal(
      (
        await api(`/api/applications/${id}/status`, {
          method: "PATCH",
          headers: {
            "X-User-Id": "r",
            "X-User-Role": "recruiter",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "Offer" }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await api(`/api/applications/${id}/status`, {
          method: "PATCH",
          headers: { ...headers, "X-Company-Id": "other-company" },
          body: JSON.stringify({ status: "Offer" }),
        })
      ).status,
      403,
    );
    assert.equal((await patch("Hired")).status, 400);
    assert.equal((await api("/api/applications/does-not-exist")).status, 404);
    assert.equal((await patch("Submitted")).body.notificationQueued, false);
    assert.equal(
      (
        await appPool.query(
          "SELECT * FROM notification_outbox WHERE application_id=$1",
          [id],
        )
      ).rowCount,
      0,
    );
    console.log("PASS identity, ownership, validation, missing IDs, no-op");

    const concurrent = await Promise.all([
      patch("Under review", id, {
        note: "Private note never included in event",
      }),
      patch("Under review", id, {
        note: "Private note never included in event",
      }),
    ]);
    assert.equal(concurrent.filter((x) => x.body.notificationQueued).length, 1);
    assert.ok(concurrent.every((x) => x.status === 200));
    const changed = concurrent.find((x) => x.body.notificationQueued)!;
    assert.equal(changed.status, 200);
    assert.equal(changed.body.notificationQueued, true);
    assert.equal(changed.body.application.history.length, 2);
    assert.equal(
      changed.body.application.resumeReference.id,
      "sample-approved-resume",
    );
    assert.equal(changed.body.application.matchSnapshot.score, 42);
    const first = await latestEvent();
    assert.equal(validateEvent(first.payload), true);
    assert.equal("note" in first.payload, false);
    await until(() => sent(first.event_id), "First email was not sent");
    assert.equal(await mailCount(first.event_id), 1);
    const list = await (
      await fetch("http://localhost:8025/api/v1/messages?limit=100")
    ).json();
    let matched: any;
    for (const message of list.messages) {
      const detail = await (
        await fetch(`http://localhost:8025/api/v1/message/${message.ID}`)
      ).json();
      if (JSON.stringify(detail).includes(first.event_id)) matched = detail;
    }
    assert.ok(matched.Text.includes("Submitted to Under review"));
    assert.ok(matched.HTML.includes("&lt;job&gt;"));
    assert.equal(matched.To[0].Address, recipient);
    await seed(appPool);
    await seed(appPool);
    assert.equal(
      (await api(`/api/applications/${id}`)).body.application.status,
      "Under review",
    );
    console.log(
      "PASS persisted status, history, outbox contract, real SMTP capture",
    );

    const functionName = `integration_fail_${suffix}`;
    await appPool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.application_id='${rollbackId}' THEN RAISE EXCEPTION 'integration rollback'; END IF; RETURN NEW; END $$`,
    );
    await appPool.query(
      `CREATE TRIGGER ${functionName} BEFORE INSERT ON notification_outbox FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    try {
      assert.equal((await patch("Offer", rollbackId)).status, 503);
      assert.equal(
        (await api(`/api/applications/${rollbackId}`)).body.application.status,
        "Submitted",
      );
      assert.equal(
        (await api(`/api/applications/${rollbackId}`)).body.application.history
          .length,
        1,
      );
    } finally {
      await appPool.query(
        `DROP TRIGGER ${functionName} ON notification_outbox`,
      );
      await appPool.query(`DROP FUNCTION ${functionName}()`);
    }
    console.log("PASS transaction rollback on outbox failure");

    compose("stop", "rabbitmq");
    try {
      await until(
        async () =>
          !(await (await fetch("http://localhost:3004/ready")).json()).broker,
        "Application did not detect broker outage",
      );
      assert.equal((await patch("Interview")).status, 200);
      const pending = await latestEvent();
      assert.equal(pending.published_at, null);
      const readiness = await fetch("http://localhost:3004/ready");
      assert.equal(readiness.status, 200);
      assert.equal((await readiness.json()).status, "degraded");
    } finally {
      compose("start", "rabbitmq");
    }
    const recovered = await latestEvent();
    await until(
      () => sent(recovered.event_id),
      "Outbox failed to recover",
      90000,
    );
    console.log("PASS broker outage and recovery without lost status change");

    compose("stop", "notification");
    try {
      assert.equal((await patch("Offer")).status, 200);
      await until(
        async () => !!(await latestEvent()).published_at,
        "Event was not confirmed",
      );
      assert.equal(
        (
          await notificationPool.query(
            "SELECT 1 FROM notification_deliveries WHERE event_id=$1",
            [(await latestEvent()).event_id],
          )
        ).rowCount,
        0,
      );
    } finally {
      compose("start", "notification");
    }
    const queued = await latestEvent();
    await until(
      () => sent(queued.event_id),
      "Stopped consumer failed to catch up",
    );
    console.log("PASS consumer outage and durable queue catch-up");

    connection = await amqp.connect(
      "amqp://rolefit:rolefit-local@localhost:5672",
    );
    connection.on("error", () => {});
    const ch = await connection.createConfirmChannel();
    ch.on("error", () => {});
    await topology(ch);
    await publishConfirmed(
      ch,
      Buffer.from(JSON.stringify(queued.payload)),
      queued.event_id,
    );
    await delay(1500);
    assert.equal(
      (
        await notificationPool.query(
          "SELECT 1 FROM notification_deliveries WHERE event_id=$1",
          [queued.event_id],
        )
      ).rowCount,
      1,
    );
    assert.equal(await mailCount(queued.event_id), 1);
    await ch.unbindQueue(QUEUE, EXCHANGE, KEY);
    try {
      await assert.rejects(
        publishConfirmed(
          ch,
          Buffer.from(JSON.stringify(queued.payload)),
          randomUUID(),
        ),
        /unroutable/,
      );
    } finally {
      await ch.bindQueue(QUEUE, EXCHANGE, KEY);
    }
    const before = (await ch.checkQueue(DEAD_QUEUE)).messageCount;
    await publishConfirmed(ch, Buffer.from("{invalid"), randomUUID());
    await until(
      async () => (await ch.checkQueue(DEAD_QUEUE)).messageCount > before,
      "Malformed event was not dead-lettered",
    );
    console.log(
      "PASS event replay, unroutable publication rejection, dead-letter queue",
    );

    compose("stop", "notification");
    try {
      const retryId = randomUUID();
      eventIds.push(retryId);
      await notificationPool.query(
        "INSERT INTO notification_deliveries(event_id,payload) VALUES($1,$2)",
        [retryId, { ...queued.payload, eventId: retryId }],
      );
      for (let attempt = 1; attempt <= 4; attempt++) {
        let calls = 0;
        await deliverNext(notificationPool, async () => {
          calls++;
          throw Object.assign(new Error("temporary"), { responseCode: 451 });
        });
        assert.equal(calls, 1);
        const row = (
          await notificationPool.query(
            "SELECT * FROM notification_deliveries WHERE event_id=$1",
            [retryId],
          )
        ).rows[0];
        assert.equal(row.attempts, attempt);
        assert.equal(row.status, attempt === 4 ? "failed" : "pending");
        if (attempt < 4) {
          const seconds = (row.next_attempt_at.getTime() - Date.now()) / 1000;
          assert.ok(seconds > [10, 30, 60][attempt - 1] - 2);
          await notificationPool.query(
            "UPDATE notification_deliveries SET next_attempt_at=now() WHERE event_id=$1",
            [retryId],
          );
        }
      }
      const permanentId = randomUUID();
      eventIds.push(permanentId);
      await notificationPool.query(
        "INSERT INTO notification_deliveries(event_id,payload) VALUES($1,$2)",
        [permanentId, { ...queued.payload, eventId: permanentId }],
      );
      await deliverNext(notificationPool, async () => {
        throw Object.assign(new Error("permanent"), { responseCode: 550 });
      });
      assert.equal(
        (
          await notificationPool.query(
            "SELECT status FROM notification_deliveries WHERE event_id=$1",
            [permanentId],
          )
        ).rows[0].status,
        "failed",
      );
      const leaseId = randomUUID();
      eventIds.push(leaseId);
      await notificationPool.query(
        "INSERT INTO notification_deliveries(event_id,payload,status,attempts,lease_until) VALUES($1,$2,'sending',1,now()-interval '1 second')",
        [leaseId, { ...queued.payload, eventId: leaseId }],
      );
      await deliverNext(notificationPool, async () => {});
      assert.equal(
        (
          await notificationPool.query(
            "SELECT status FROM notification_deliveries WHERE event_id=$1",
            [leaseId],
          )
        ).rows[0].status,
        "sent",
      );
      const exhaustedLease = randomUUID();
      eventIds.push(exhaustedLease);
      await notificationPool.query(
        "INSERT INTO notification_deliveries(event_id,payload,status,attempts,lease_until) VALUES($1,$2,'sending',4,now()-interval '1 second')",
        [exhaustedLease, { ...queued.payload, eventId: exhaustedLease }],
      );
      await deliverNext(notificationPool, async () =>
        assert.fail("Must not send a fifth email"),
      );
      const exhausted = (
        await notificationPool.query(
          "SELECT status,attempts FROM notification_deliveries WHERE event_id=$1",
          [exhaustedLease],
        )
      ).rows[0];
      assert.equal(exhausted.status, "failed");
      assert.equal(exhausted.attempts, 4);
    } finally {
      compose("start", "notification");
    }
    console.log(
      "PASS durable retry exhaustion, permanent rejection, expired lease recovery",
    );
    compose("stop", "mailpit");
    let outageEvent: string;
    try {
      assert.equal((await patch("Rejected")).status, 200);
      outageEvent = (await latestEvent()).event_id;
      await until(
        async () =>
          !!(
            await notificationPool.query(
              "SELECT 1 FROM notification_deliveries WHERE event_id=$1 AND status='pending' AND attempts>=1",
              [outageEvent],
            )
          ).rowCount,
        "SMTP outage did not produce a durable retry",
      );
    } finally {
      compose("start", "mailpit");
    }
    await until(
      () => sent(outageEvent!),
      "SMTP retry did not recover after Mailpit restart",
    );
    console.log(
      "PASS actual SMTP outage, durable retry, and email delivery after recovery",
    );
    compose("stop", "postgres");
    try {
      await until(
        async () => (await fetch("http://localhost:3004/ready")).status === 503,
        "Application readiness did not detect database outage",
      );
      assert.equal((await fetch("http://localhost:3005/ready")).status, 503);
      assert.equal((await patch("Interview")).status, 503);
    } finally {
      compose("start", "postgres");
    }
    await until(
      async () => (await fetch("http://localhost:3004/ready")).ok,
      "Database did not recover",
    );
    console.log("PASS database outage readiness and failed write");
    await connection.close();
    connection = undefined;
    compose(
      "restart",
      "postgres",
      "rabbitmq",
      "application",
      "notification",
      "mailpit",
    );
    await until(
      async () => (await fetch("http://localhost:3005/ready")).ok,
      "Stack did not recover after restart",
      90000,
    );
    assert.equal(
      (await api(`/api/applications/${id}`)).body.application.status,
      "Rejected",
    );
    assert.equal(await mailCount(first.event_id), 1);
    assert.equal(await sent(first.event_id), true);
    assert.equal((await patch("Rejected")).body.notificationQueued, false);
    console.log("PASS persistence across full stack restart");
    console.log(
      "ALL LOCAL INTEGRATION CHECKS PASSED (gateway authentication not exercised)",
    );
  } finally {
    await connection?.close().catch(() => {});
    compose("start", "rabbitmq", "notification");
    await until(async () => {
      await appPool.query("SELECT 1");
      return true;
    }, "Database unavailable during cleanup");
    await appPool.query(
      "DELETE FROM notification_outbox WHERE application_id=ANY($1)",
      [fixtureIds],
    );
    await appPool.query(
      "DELETE FROM application_status_history WHERE application_id=ANY($1)",
      [fixtureIds],
    );
    await appPool.query("DELETE FROM applications WHERE id=ANY($1)", [
      fixtureIds,
    ]);
    await notificationPool.query(
      "DELETE FROM notification_deliveries WHERE event_id=ANY($1::uuid[])",
      [eventIds],
    );
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await appPool.end();
    await notificationPool.end();
  });
