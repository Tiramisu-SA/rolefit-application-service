import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { type Status, type StatusEvent, validateEvent } from "./event";

export class AppError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface Caller {
  userId: string;
  role: "seeker" | "recruiter";
  companyId?: string;
}
export interface Application {
  id: string;
  jobId: string;
  companyId: string;
  candidateId: string;
  candidate: { id: string; name: string; email: string };
  jobSnapshot: { id: string; title: string; companyId: string };
  resumeReference: unknown;
  matchSnapshot: unknown;
  status: Status;
  submittedAt: string;
  updatedAt: string;
  history: {
    status: Status;
    at: string;
    changedBy: string;
    note: string | null;
  }[];
}
function authorize(
  caller: Caller,
  row: Record<string, any>,
  write = false,
): void {
  const allowed =
    caller.role === "recruiter"
      ? caller.companyId === row.company_id
      : !write && caller.userId === row.candidate_id;
  if (!allowed)
    throw new AppError(
      403,
      "FORBIDDEN",
      "You do not have access to this application",
    );
}
export interface ApplicationStore {
  get(id: string, caller: Caller): Promise<Application>;
  mine(caller: Caller): Promise<Application[]>;
  applicants(jobId: string, caller: Caller): Promise<Application[]>;
  update(
    id: string,
    status: Status,
    note: string | undefined,
    caller: Caller,
  ): Promise<{ application: Application; notificationQueued: boolean }>;
}
// Read status and history from the same PostgreSQL statement snapshot.
const APPLICATION_READ = `SELECT applications.*,
 (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.id),'[]'::jsonb)
  FROM application_status_history h WHERE h.application_id=applications.id) AS history_rows
 FROM applications`;

export class Repository implements ApplicationStore {
  constructor(readonly pool: Pool) {}
  private async hydrate(
    row: Record<string, any>,
    db: Pool | PoolClient = this.pool,
  ): Promise<Application> {
    const history = row.history_rows
      ? { rows: row.history_rows as Record<string, any>[] }
      : await db.query(
          "SELECT status,at,changed_by,note FROM application_status_history WHERE application_id=$1 ORDER BY id",
          [row.id],
        );
    return {
      id: row.id,
      jobId: row.job_id,
      companyId: row.company_id,
      candidateId: row.candidate_id,
      candidate: row.candidate,
      jobSnapshot: row.job_snapshot,
      resumeReference: row.resume_reference,
      matchSnapshot: row.match_snapshot,
      status: row.status,
      submittedAt: row.submitted_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      history: history.rows.map((x) => ({
        status: x.status,
        at: new Date(x.at).toISOString(),
        changedBy: x.changed_by,
        note: x.note,
      })),
    };
  }
  async get(id: string, caller: Caller): Promise<Application> {
    const { rows } = await this.pool.query(`${APPLICATION_READ} WHERE id=$1`, [
      id,
    ]);
    if (!rows[0])
      throw new AppError(404, "APPLICATION_NOT_FOUND", "Application not found");
    authorize(caller, rows[0]);
    return this.hydrate(rows[0]);
  }
  async mine(caller: Caller): Promise<Application[]> {
    if (caller.role !== "seeker")
      throw new AppError(403, "FORBIDDEN", "This endpoint is for job seekers");
    const { rows } = await this.pool.query(
      `${APPLICATION_READ} WHERE candidate_id=$1 ORDER BY updated_at DESC,id`,
      [caller.userId],
    );
    return Promise.all(rows.map((x) => this.hydrate(x)));
  }
  async applicants(jobId: string, caller: Caller): Promise<Application[]> {
    if (caller.role !== "recruiter")
      throw new AppError(403, "FORBIDDEN", "This endpoint is for recruiters");
    // No private upstream database access or live matching calls. Filter by owned application snapshots.
    const { rows } = await this.pool.query(
      `${APPLICATION_READ} WHERE job_id=$1 AND company_id=$2 ORDER BY updated_at DESC,id`,
      [jobId, caller.companyId],
    );
    return Promise.all(rows.map((x) => this.hydrate(x)));
  }
  async update(
    id: string,
    status: Status,
    note: string | undefined,
    caller: Caller,
  ): Promise<{ application: Application; notificationQueued: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT * FROM applications WHERE id=$1 FOR UPDATE",
        [id],
      );
      const row = rows[0];
      if (!row)
        throw new AppError(
          404,
          "APPLICATION_NOT_FOUND",
          "Application not found",
        );
      authorize(caller, row, true);
      if (row.status === status) {
        const application = await this.hydrate(row, client);
        await client.query("COMMIT");
        return { application, notificationQueued: false };
      }
      const at = new Date().toISOString();
      const event: StatusEvent = {
        eventId: randomUUID(),
        schemaVersion: 1,
        eventType: "application.status.changed.v1",
        occurredAt: at,
        applicationId: id,
        jobId: row.job_id,
        candidateId: row.candidate_id,
        recipient: { name: row.candidate.name, email: row.candidate.email },
        jobTitle: row.job_snapshot.title,
        previousStatus: row.status,
        newStatus: status,
      };
      if (!validateEvent(event))
        throw new AppError(
          409,
          "NOTIFICATION_DATA_INVALID",
          "Application requires a valid recipient and job snapshot",
        );
      const updated = await client.query(
        "UPDATE applications SET status=$2,updated_at=$3 WHERE id=$1 RETURNING *",
        [id, status, at],
      );
      await client.query(
        "INSERT INTO application_status_history(application_id,status,at,changed_by,note) VALUES ($1,$2,$3,$4,$5)",
        [id, status, at, caller.userId, note || null],
      );
      await client.query(
        "INSERT INTO notification_outbox(event_id,application_id,payload) VALUES ($1,$2,$3)",
        [event.eventId, id, event],
      );
      const application = await this.hydrate(updated.rows[0], client);
      await client.query("COMMIT");
      return { application, notificationQueued: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
