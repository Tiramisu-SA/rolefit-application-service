import { randomUUID } from "node:crypto";
import { validateReminderEvent, type ReminderEvent } from "./event";
import { logger } from "./logger";

export interface ReminderDeps {
  listPublishedJobs(): Promise<
    Array<{ id: string; title: string; deadline?: string }>
  >;
  listDraftsForJobs(
    jobIds: string[],
  ): Promise<Array<{ candidateId: string; jobId: string }>>;
  hasAppliedOrReminded(candidateId: string, jobId: string): Promise<boolean>;
  getCandidate(candidateId: string): Promise<{ name: string; email: string }>;
  recordReminder(event: ReminderEvent): Promise<boolean>; // false if already reminded
}

const BATCH = 100;

/** Queues a reminder for each prepared-but-unsent application whose deadline is near. Returns the count queued. */
export async function runReminderCheck(
  deps: ReminderDeps,
  now: Date,
  windowHours: number,
): Promise<number> {
  const end = now.getTime() + windowHours * 3_600_000;
  const jobs = (await deps.listPublishedJobs()).filter((job) => {
    const at = job.deadline ? Date.parse(job.deadline) : NaN;
    return Number.isFinite(at) && at > now.getTime() && at <= end;
  });
  const byId = new Map(jobs.map((job) => [job.id, job]));
  let queued = 0;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const drafts = await deps.listDraftsForJobs(
      jobs.slice(i, i + BATCH).map((job) => job.id),
    );
    for (const { candidateId, jobId } of drafts) {
      const job = byId.get(jobId);
      if (!job) continue;
      try {
        if (await deps.hasAppliedOrReminded(candidateId, jobId)) continue;
        const candidate = await deps.getCandidate(candidateId);
        const event: ReminderEvent = {
          eventId: randomUUID(),
          schemaVersion: 1,
          eventType: "job.deadline.reminder.v1",
          occurredAt: now.toISOString(),
          jobId,
          candidateId,
          recipient: { name: candidate.name, email: candidate.email },
          jobTitle: job.title,
          deadline: job.deadline!,
        };
        if (!validateReminderEvent(event)) {
          logger.warn("Skipping reminder with invalid data", {
            candidateId,
            jobId,
          });
          continue;
        }
        if (await deps.recordReminder(event)) queued++;
      } catch (error) {
        logger.error("Reminder skipped for one candidate", {
          candidateId,
          jobId,
          error: error instanceof Error ? error : undefined,
        });
      }
    }
  }
  return queued;
}

/** Runs the check every intervalMs (first run after one interval). Returns a stop function. */
export function startReminderScheduler(
  deps: ReminderDeps,
  opts: { intervalMs: number; windowHours: number },
): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const queued = await runReminderCheck(
        deps,
        new Date(),
        opts.windowHours,
      );
      if (queued) logger.info("Deadline reminders queued", { queued });
    } catch (error) {
      logger.error("Deadline reminder check failed", {
        error: error instanceof Error ? error : undefined,
      });
    } finally {
      running = false;
    }
  }, opts.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
