/** Real PostgreSQL/RabbitMQ/Mailpit; upstreams are labelled contract stubs, not live teammate services. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import * as grpc from "@grpc/grpc-js";
import { createApp } from "../src/app";
import { Repository } from "../src/repository";
import { SubmissionService } from "../src/submission";
import { UpstreamClients } from "../src/upstreams";
import { migrate } from "../src/migrate";
import { startFixtures } from "./submission-fixtures";
const candidateId = randomUUID();
const suffix = candidateId.replaceAll("-", "");
const job = `job_submit_${suffix}`;
const rollbackJob = `job_rollback_${suffix}`;
const pool = new Pool({
  connectionString:
    process.env.SUBMISSION_TEST_DATABASE_URL ||
    "postgresql://application:application-local@localhost:5433/application",
});
const notificationPool = new Pool({
  connectionString:
    "postgresql://notification:notification-local@localhost:5433/notification",
});
pool.on("error", () => {});
notificationPool.on("error", () => {});
async function main() {
  await migrate(pool);
  const fixtures = await startFixtures(candidateId, job);
  fixtures.state.profile.email = `submit-${suffix}@example.test`;
  const sources = new UpstreamClients(fixtures.config);
  const repo = new Repository(pool);
  const server = createApp(
    repo,
    async () => ({ database: true, broker: false }),
    new SubmissionService(repo, sources),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    "X-User-Id": candidateId,
    "X-User-Role": "seeker",
    Authorization: "Bearer contract-test-token",
    "Content-Type": "application/json",
  };
  const ids: string[] = [];
  const eventIds: string[] = [];
  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(origin + path, {
      ...options,
      headers: options.headers || headers,
    });
    return { status: response.status, body: await response.json() };
  }
  const submit = (body: unknown = { jobId: job }) =>
    request("/api/applications", {
      method: "POST",
      body: JSON.stringify(body),
    });
  const count = async () =>
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM applications WHERE candidate_id=$1",
          [candidateId],
        )
      ).rows[0].count,
    );
  const resetJob = (id: string) => {
    fixtures.state.resume.jobId = id;
    fixtures.state.match.jobId = id;
  };
  try {
    assert.equal(
      (await submit({ jobId: job, candidateId: randomUUID() })).status,
      400,
    );
    assert.equal(
      (
        await request("/api/applications", {
          method: "POST",
          headers: {
            ...headers,
            "X-User-Role": "recruiter",
            "X-Company-Id": "co-contract",
          },
          body: JSON.stringify({ jobId: job }),
        })
      ).status,
      403,
    );
    fixtures.state.resumeError = grpc.status.FAILED_PRECONDITION;
    assert.equal((await submit()).body.error.code, "RESUME_NOT_APPROVED");
    fixtures.state.resumeError = 0;
    fixtures.state.discoveryStatus = 503;
    assert.equal((await submit()).status, 503);
    fixtures.state.discoveryStatus = 200;
    fixtures.state.match.candidateId = randomUUID();
    assert.equal((await submit()).body.error.code, "UPSTREAM_RESPONSE_INVALID");
    fixtures.state.match.candidateId = candidateId;
    fixtures.state.profile.email = "invalid";
    assert.equal((await submit()).body.error.code, "PROFILE_INCOMPLETE");
    fixtures.state.profile.email = `submit-${suffix}@example.test`;
    assert.equal(await count(), 0);
    console.log("PASS rejection and dependency failures create no application");
    const responses = await Promise.all([submit(), submit()]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    const application = responses.find((r) => r.status === 201)!.body
      .application;
    ids.push(application.id);
    assert.equal(await count(), 1);
    assert.equal(application.status, "Submitted");
    assert.equal(application.history.length, 1);
    assert.equal(application.development, null);
    assert.equal(application.history[0].changedBy, candidateId);
    assert.deepEqual(application.resumeSnapshot, fixtures.state.resume);
    assert.equal(application.matchSnapshot.score, 70);
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM notification_outbox WHERE application_id=$1",
          [application.id],
        )
      ).rowCount,
      0,
    );
    assert.equal((await submit()).body.error.code, "ALREADY_APPLIED");
    console.log(
      "PASS concurrent submission: one committed application/history, one 409, no initial notification",
    );
    fixtures.state.resume.sections[0].bullets[0].text =
      "Changed after submission";
    fixtures.state.match.score = 10;
    fixtures.state.profile.name = "Changed candidate";
    fixtures.state.resumeError = grpc.status.FAILED_PRECONDITION;
    const calls = fixtures.state.calls.length;
    const read = (await request(`/api/applications/${application.id}`)).body
      .application;
    assert.equal(
      read.resumeSnapshot.sections[0].bullets[0].text,
      "Contract test resume",
    );
    assert.equal(read.matchSnapshot.score, 70);
    assert.equal(read.candidate.name, "Contract <candidate>");
    assert.equal(fixtures.state.calls.length, calls);
    assert.equal(
      (
        await request(`/api/applications/${application.id}`, {
          headers: { ...headers, "X-User-Id": randomUUID() },
        })
      ).status,
      403,
    );
    const recruiter = {
      "X-User-Id": "contract-recruiter",
      "X-User-Role": "recruiter",
      "X-Company-Id": "co-contract",
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await request(`/api/applications/${application.id}`, {
          headers: recruiter,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/api/applications/${application.id}`, {
          headers: { ...recruiter, "X-Company-Id": "other" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("/api/applications/mine")).body.applications.length,
      1,
    );
    console.log(
      "PASS immutable snapshot readback, seeker/company isolation, no upstream calls on reads",
    );
    fixtures.state.resumeError = 0;
    resetJob(rollbackJob);
    await pool.query(`CREATE FUNCTION fail_submission_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.changed_by='${candidateId}' AND (SELECT job_id FROM applications WHERE id=NEW.application_id)='${rollbackJob}' THEN
        RAISE EXCEPTION 'Injected initial history failure'; END IF; RETURN NEW; END $$`);
    await pool.query(
      `CREATE TRIGGER fail_submission_${suffix} BEFORE INSERT ON application_status_history FOR EACH ROW EXECUTE FUNCTION fail_submission_${suffix}()`,
    );
    assert.equal((await submit({ jobId: rollbackJob })).status, 503);
    assert.equal(await count(), 1);
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM applications WHERE candidate_id=$1 AND job_id=$2",
          [candidateId, rollbackJob],
        )
      ).rowCount,
      0,
    );
    await pool.query(
      `DROP TRIGGER fail_submission_${suffix} ON application_status_history`,
    );
    await pool.query(`DROP FUNCTION fail_submission_${suffix}()`);
    console.log(
      "PASS initial-history failure rolls back application insertion",
    );
    const coverJob = `job_cover_${suffix}`;
    resetJob(coverJob);
    fixtures.state.requireCoverLetter = true;
    assert.equal(
      (await submit({ jobId: coverJob })).body.error.code,
      "COVER_LETTER_REQUIRED",
    );
    const covered = (
      await submit({
        jobId: coverJob,
        coverLetter: "  Contract cover letter  ",
      })
    ).body.application;
    ids.push(covered.id);
    assert.equal(covered.coverLetter, "Contract cover letter");
    console.log("PASS cover-letter requirement and persistence");
    const uploadJob = `job_upload_${suffix}`;
    resetJob(uploadJob);
    fixtures.state.requireCoverLetter = false;
    fixtures.state.resumeError = grpc.status.FAILED_PRECONDITION;
    const pdfBytes = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from([0, 255, 128, 10, 13]),
      Buffer.alloc(2000, 9),
    ]);
    const uploaded = await submit({
      jobId: uploadJob,
      resumeFile: {
        fileName: "Jane Doe.pdf",
        contentType: "application/pdf",
        contentBase64: pdfBytes.toString("base64"),
      },
    });
    fixtures.state.resumeError = 0;
    assert.equal(uploaded.status, 201);
    const up = uploaded.body.application;
    ids.push(up.id);
    assert.equal(up.resumeSource, "uploaded");
    assert.equal(up.resumeSnapshot, null);
    assert.deepEqual(up.resumeFile, {
      fileName: "Jane Doe.pdf",
      contentType: "application/pdf",
      sizeBytes: pdfBytes.length,
    });
    const stored = (
      await pool.query(
        "SELECT content,size_bytes FROM application_resume_files WHERE application_id=$1",
        [up.id],
      )
    ).rows[0];
    assert.ok(stored.content.equals(pdfBytes));
    const download = async (hdrs: Record<string, string>) => {
      const res = await fetch(
        `${origin}/api/applications/${up.id}/resume-file`,
        { headers: hdrs },
      );
      return { res, bytes: Buffer.from(await res.arrayBuffer()) };
    };
    const companyRecruiter = {
      "X-User-Id": "upload-recruiter",
      "X-User-Role": "recruiter",
      "X-Company-Id": "co-contract",
    };
    const asApplicant = await download(headers);
    assert.equal(asApplicant.res.status, 200);
    assert.equal(
      asApplicant.res.headers.get("content-type"),
      "application/pdf",
    );
    assert.equal(
      asApplicant.res.headers.get("content-disposition"),
      "attachment; filename*=UTF-8''Jane%20Doe.pdf",
    );
    assert.ok(asApplicant.bytes.equals(pdfBytes));
    const asRecruiter = await download(companyRecruiter);
    assert.equal(asRecruiter.res.status, 200);
    assert.ok(asRecruiter.bytes.equals(pdfBytes));
    assert.equal(
      (await download({ ...companyRecruiter, "X-Company-Id": "other-co" })).res
        .status,
      403,
    );
    assert.equal(
      (await download({ ...headers, "X-User-Id": randomUUID() })).res.status,
      403,
    );
    const mineText = await (
      await fetch(origin + "/api/applications/mine", { headers })
    ).text();
    const applicantsText = await (
      await fetch(`${origin}/api/applications?jobId=${uploadJob}`, {
        headers: companyRecruiter,
      })
    ).text();
    for (const text of [mineText, applicantsText]) {
      assert.ok(!text.includes(pdfBytes.toString("base64").slice(0, 40)));
      assert.ok(text.includes('"resumeSource":"uploaded"'));
      assert.ok(text.includes('"sizeBytes":' + pdfBytes.length));
      assert.ok(!text.includes("contentBase64"));
    }
    const tailoredFile = await fetch(
      `${origin}/api/applications/${application.id}/resume-file`,
      { headers },
    );
    assert.equal(tailoredFile.status, 404);
    assert.equal(
      (await tailoredFile.json()).error.code,
      "RESUME_FILE_NOT_FOUND",
    );
    console.log(
      "PASS uploaded resume: stored in Postgres, downloadable by applicant and company recruiter, 403 for others, lists carry metadata only",
    );
    const changed = await request(
      `/api/applications/${application.id}/status`,
      { method: "PATCH", headers: recruiter, body: '{"status":"Interview"}' },
    );
    assert.equal(changed.status, 200);
    assert.equal(changed.body.notificationQueued, true);
    const event = (
      await pool.query(
        "SELECT event_id,payload FROM notification_outbox WHERE application_id=$1",
        [application.id],
      )
    ).rows[0];
    eventIds.push(event.event_id);
    assert.equal(
      event.payload.recipient.email,
      `submit-${suffix}@example.test`,
    );
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
    assert.equal(
      sent,
      true,
      "Existing Application outbox publisher and Notification/Mailpit must be running",
    );
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
      }
    }
    assert.equal(captured, true);
    console.log(
      "PASS submitted application -> later status change -> real RabbitMQ -> Notification -> Mailpit email",
    );
    console.log(
      "ALL SUBMISSION INTEGRATION CHECKS PASSED (real PostgreSQL/broker/email; contract-stub upstreams; gateway/JWT not exercised)",
    );
  } finally {
    await pool
      .query(
        `DROP TRIGGER IF EXISTS fail_submission_${suffix} ON application_status_history`,
      )
      .catch(() => {});
    await pool
      .query(`DROP FUNCTION IF EXISTS fail_submission_${suffix}()`)
      .catch(() => {});
    await notificationPool.query(
      "DELETE FROM notification_deliveries WHERE event_id=ANY($1::uuid[])",
      [eventIds],
    );
    // Candidate UUID is unique to this run; clean up even if a response assertion failed before recording an ID.
    await pool.query(
      "DELETE FROM application_resume_files WHERE application_id IN (SELECT id FROM applications WHERE candidate_id=$1)",
      [candidateId],
    );
    await pool.query(
      "DELETE FROM notification_outbox WHERE application_id IN (SELECT id FROM applications WHERE candidate_id=$1)",
      [candidateId],
    );
    await pool.query(
      "DELETE FROM application_status_history WHERE application_id IN (SELECT id FROM applications WHERE candidate_id=$1)",
      [candidateId],
    );
    await pool.query("DELETE FROM applications WHERE candidate_id=$1", [
      candidateId,
    ]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sources.close();
    await fixtures.close();
    await pool.end();
    await notificationPool.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
