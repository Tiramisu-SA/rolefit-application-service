import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReminderEvent, type ReminderEvent } from "../src/event";
import {
  runReminderCheck,
  startReminderScheduler,
  type ReminderDeps,
} from "../src/reminder";

const now = new Date("2026-11-07T00:00:00Z");
type Job = { id: string; title: string; deadline?: string };

function fakes(
  jobs: Job[],
  drafts: Array<{ candidateId: string; jobId: string }>,
  over: Partial<ReminderDeps> = {},
) {
  const recorded: ReminderEvent[] = [];
  const seen = new Set<string>();
  const batches: string[][] = [];
  const deps: ReminderDeps = {
    listPublishedJobs: async () => jobs,
    listDraftsForJobs: async (ids) => {
      batches.push(ids);
      return drafts.filter((d) => ids.includes(d.jobId));
    },
    hasAppliedOrReminded: async (c, j) => seen.has(`${c}:${j}`),
    getCandidate: async () => ({ name: "Sam", email: "sam@example.test" }),
    recordReminder: async (e) => {
      const key = `${e.candidateId}:${e.jobId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      recorded.push(e);
      return true;
    },
    ...over,
  };
  return { deps, recorded, batches };
}

const soon: Job = {
  id: "job-1",
  title: "Backend Engineer",
  deadline: "2026-11-08T12:00:00Z",
};
const draft = { candidateId: "c-1", jobId: "job-1" };

test("queues one valid reminder for a prepared, unsent application", async () => {
  const { deps, recorded } = fakes([soon], [draft]);
  assert.equal(await runReminderCheck(deps, now, 48), 1);
  const [event] = recorded;
  assert.equal(validateReminderEvent(event), true);
  assert.equal(event.eventType, "job.deadline.reminder.v1");
  assert.equal(event.jobTitle, "Backend Engineer");
  assert.equal(event.deadline, "2026-11-08T12:00:00Z");
  assert.deepEqual(event.recipient, { name: "Sam", email: "sam@example.test" });
});

test("ignores deadlines outside the window, in the past, or missing", async () => {
  for (const deadline of [
    "2026-11-10T00:00:00Z",
    "2026-11-06T00:00:00Z",
    undefined,
  ]) {
    const { deps } = fakes([{ ...soon, deadline }], [draft]);
    assert.equal(await runReminderCheck(deps, now, 48), 0);
  }
});

test("skips pairs already applied or reminded", async () => {
  const { deps } = fakes([soon], [draft], {
    hasAppliedOrReminded: async () => true,
  });
  assert.equal(await runReminderCheck(deps, now, 48), 0);
});

test("a failing candidate lookup does not stop other reminders", async () => {
  const { deps } = fakes(
    [soon],
    [draft, { candidateId: "c-2", jobId: "job-1" }],
    {
      getCandidate: async (id) => {
        if (id === "c-1") throw new Error("profile down");
        return { name: "Kim", email: "kim@example.test" };
      },
    },
  );
  assert.equal(await runReminderCheck(deps, now, 48), 1);
});

test("asks for drafts in batches of at most 100 jobs", async () => {
  const jobs = Array.from({ length: 150 }, (_, i) => ({
    ...soon,
    id: `job-${i}`,
  }));
  const { deps, batches } = fakes(jobs, []);
  await runReminderCheck(deps, now, 48);
  assert.deepEqual(
    batches.map((b) => b.length),
    [100, 50],
  );
});

test("a second run queues nothing", async () => {
  const { deps } = fakes([soon], [draft]);
  assert.equal(await runReminderCheck(deps, now, 48), 1);
  assert.equal(await runReminderCheck(deps, now, 48), 0);
});

test("scheduler runs on an interval, skips overlapping ticks, and stops", async () => {
  let calls = 0;
  let release!: () => void;
  const { deps } = fakes([], [], {
    listPublishedJobs: async () => {
      calls++;
      await new Promise<void>((r) => (release = r));
      return [];
    },
  });
  const stop = startReminderScheduler(deps, { intervalMs: 10, windowHours: 48 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1);
  release();
  await new Promise((r) => setTimeout(r, 30));
  stop();
  const after = calls;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, after);
  release?.();
});
