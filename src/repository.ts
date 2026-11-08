import type {
  ApprovedResume,
  SubmissionData,
  SubmissionDevelopment,
} from "./submission";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  type ReminderEvent,
  type Status,
  type StatusEvent,
  validateEvent,
} from "./event";
import { currentRequestId } from "./request-context";

export interface FieldError {
  field: string;
  message: string;
}
export class AppError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly details?: FieldError[],
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
  development: SubmissionDevelopment | null;
  id: string;
  jobId: string;
  companyId: string;
  candidateId: string;
  candidate: { id: string; name: string; email: string };
  jobSnapshot: { id: string; title: string; companyId: string };
  resumeReference: unknown;
  matchSnapshot: unknown;
  resumeSnapshot: ApprovedResume | null;
  resumeSource: "tailored" | "uploaded";
  resumeFile: { fileName: string; contentType: string; sizeBytes: number } | null;
  coverLetter: string | null;
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
export interface StoredResumeFile {
  fileName: string;
  contentType: string;
  content: Buffer;
}
export interface ApplicationStore {
  hasApplication(jobId: string, candidateId: string): Promise<boolean>;
  submit(data: SubmissionData, caller: Caller): Promise<Application>;
  get(id: string, caller: Caller): Promise<Application>;
  /** Same access rule as get(). RESUME_FILE_NOT_FOUND when nothing was uploaded. */
  getResumeFile(id: string, caller: Caller): Promise<StoredResumeFile>;
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
// File bytes are never selected here, only metadata.
const APPLICATION_READ = `SELECT applications.*,
 (SELECT jsonb_build_object('fileName',f.file_name,'contentType',f.content_type,'sizeBytes',f.size_bytes)
  FROM application_resume_files f WHERE f.application_id=applications.id) AS resume_file_meta,
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
    let resumeFile = row.resume_file_meta ?? null;
    if (!("resume_file_meta" in row) && row.resume_source === "uploaded") {
      const meta = await db.query(
        "SELECT file_name,content_type,size_bytes FROM application_resume_files WHERE application_id=$1",
        [row.id],
      );
      resumeFile = meta.rows[0]
        ? {
            fileName: meta.rows[0].file_name,
            contentType: meta.rows[0].content_type,
            sizeBytes: meta.rows[0].size_bytes,
          }
        : null;
    }
    return {
      development: row.development ?? null,
      id: row.id,
      jobId: row.job_id,
      companyId: row.company_id,
      candidateId: row.candidate_id,
      candidate: row.candidate,
      jobSnapshot: row.job_snapshot,
      resumeReference: row.resume_reference,
      matchSnapshot: row.match_snapshot,
      resumeSnapshot: row.resume_snapshot ?? null,
      resumeSource: row.resume_source ?? "tailored",
      resumeFile,
      coverLetter: row.cover_letter ?? null,
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
  async hasApplication(jobId: string, candidateId: string): Promise<boolean> {
    return !!(
      await this.pool.query(
        "SELECT 1 FROM applications WHERE job_id=$1 AND candidate_id=$2",
        [jobId, candidateId],
      )
    ).rowCount;
  }
  async submit(data: SubmissionData, caller: Caller): Promise<Application> {
    if (caller.role !== "seeker" || data.candidate.id !== caller.userId)
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only the owning seeker can submit an application",
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO applications(id,job_id,company_id,candidate_id,candidate,job_snapshot,resume_reference,
          resume_snapshot,match_snapshot,cover_letter,development,resume_source,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Submitted') RETURNING *`,
        [
          `app_${randomUUID()}`,
          data.jobId,
          data.companyId,
          caller.userId,
          data.candidate,
          data.jobSnapshot,
          data.resumeReference,
          data.resumeSnapshot,
          data.matchSnapshot,
          data.coverLetter,
          data.development,
          data.resumeUpload ? "uploaded" : "tailored",
        ],
      );
      const row = inserted.rows[0];
      if (data.resumeUpload)
        await client.query(
          `INSERT INTO application_resume_files(application_id,file_name,content_type,size_bytes,content)
           VALUES($1,$2,$3,$4,$5)`,
          [
            row.id,
            data.resumeUpload.fileName,
            data.resumeUpload.contentType,
            data.resumeUpload.content.length,
            data.resumeUpload.content,
          ],
        );
      await client.query(
        "INSERT INTO application_status_history(application_id,status,at,changed_by,note) VALUES($1,'Submitted',$2,$3,NULL)",
        [row.id, row.submitted_at, caller.userId],
      );
      // Initial submission is not a status-change notification.
      const application = await this.hydrate(row, client);
      await client.query("COMMIT");
      return application;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (
        (error as { code?: string; constraint?: string }).code === "23505" &&
        (error as { constraint?: string }).constraint ===
          "applications_candidate_job_unique"
      )
        throw new AppError(
          409,
          "ALREADY_APPLIED",
          "You have already applied to this job",
        );
      throw error;
    } finally {
      client.release();
    }
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
  async getResumeFile(id: string, caller: Caller): Promise<StoredResumeFile> {
    const { rows } = await this.pool.query(
      "SELECT id,company_id,candidate_id FROM applications WHERE id=$1",
      [id],
    );
    if (!rows[0])
      throw new AppError(404, "APPLICATION_NOT_FOUND", "Application not found");
    authorize(caller, rows[0]);
    const file = await this.pool.query(
      "SELECT file_name,content_type,content FROM application_resume_files WHERE application_id=$1",
      [id],
    );
    if (!file.rows[0])
      throw new AppError(
        404,
        "RESUME_FILE_NOT_FOUND",
        "This application has no uploaded resume file",
      );
    return {
      fileName: file.rows[0].file_name,
      contentType: file.rows[0].content_type,
      content: file.rows[0].content,
    };
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
        "INSERT INTO notification_outbox(event_id,application_id,payload,request_id) VALUES ($1,$2,$3,$4)",
        [event.eventId, id, event, currentRequestId() ?? null],
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
  async hasAppliedOrReminded(
    candidateId: string,
    jobId: string,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "SELECT 1 FROM applications WHERE candidate_id=$1 AND job_id=$2 UNION ALL SELECT 1 FROM deadline_reminders WHERE candidate_id=$1 AND job_id=$2 LIMIT 1",
      [candidateId, jobId],
    );
    return (rowCount ?? 0) > 0;
  }
  /** Records the reminder and its outbox event atomically. False if already reminded. */
  async recordReminder(event: ReminderEvent): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        "INSERT INTO deadline_reminders(candidate_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING 1",
        [event.candidateId, event.jobId],
      );
      if (!inserted.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "INSERT INTO notification_outbox(event_id,application_id,payload,request_id) VALUES ($1,NULL,$2,NULL)",
        [event.eventId, event],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
