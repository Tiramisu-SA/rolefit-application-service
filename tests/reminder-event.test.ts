import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateReminderEvent } from "../src/event";
import { publishNext } from "../src/outbox";
import { KEY, QUEUE, REMINDER_KEY, topology } from "../src/broker";

const reminder = () => ({
  eventId: randomUUID(),
  schemaVersion: 1 as const,
  eventType: "job.deadline.reminder.v1" as const,
  occurredAt: "2026-11-07T10:00:00Z",
  jobId: "job-1",
  candidateId: "user-1",
  recipient: { name: "Sam Seeker", email: "sam@example.test" },
  jobTitle: "Backend Engineer",
  deadline: "2026-11-08T12:00:00Z",
});

test("a valid reminder passes validation", () => {
  assert.equal(validateReminderEvent(reminder()), true);
});

test("a reminder without a deadline is rejected", () => {
  const { deadline: _deadline, ...rest } = reminder();
  assert.equal(validateReminderEvent(rest), false);
});

test("a reminder with the wrong event type is rejected", () => {
  assert.equal(
    validateReminderEvent({
      ...reminder(),
      eventType: "application.status.changed.v1",
    }),
    false,
  );
});

function fakeOutbox(payload: Record<string, unknown>) {
  const client = {
    query: async (sql: string) =>
      sql.startsWith("SELECT")
        ? {
            rows: [
              {
                event_id: payload.eventId,
                payload,
                request_id: null,
              },
            ],
          }
        : { rows: [] },
    release: () => {},
  };
  const keys: string[] = [];
  const channel = {
    on: () => {},
    off: () => {},
    publish: (
      _exchange: string,
      key: string,
      _body: Buffer,
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => {
      keys.push(key);
      callback(null);
    },
  };
  return {
    keys,
    pool: { connect: async () => client } as never,
    broker: { ready: true, channel, disconnect: async () => {} } as never,
  };
}

test("the outbox routes events by their event type", async () => {
  const r = fakeOutbox(reminder());
  assert.equal(await publishNext(r.pool, r.broker), true);
  assert.deepEqual(r.keys, ["job.deadline.reminder.v1"]);

  const s = fakeOutbox({
    eventId: randomUUID(),
    eventType: "application.status.changed.v1",
  });
  assert.equal(await publishNext(s.pool, s.broker), true);
  assert.deepEqual(s.keys, ["application.status.changed.v1"]);
});

test("topology binds the notification queue to status and reminder keys", async () => {
  const binds: string[][] = [];
  const ch = {
    assertExchange: async () => {},
    assertQueue: async () => {},
    bindQueue: async (q: string, _e: string, k: string) => {
      binds.push([q, k]);
    },
  };
  await topology(ch as never);
  assert.ok(binds.some(([q, k]) => q === QUEUE && k === KEY));
  assert.ok(binds.some(([q, k]) => q === QUEUE && k === REMINDER_KEY));
});

test("a non-string event type falls back to the status key", async () => {
  const o = fakeOutbox({ eventId: randomUUID(), eventType: 5 });
  assert.equal(await publishNext(o.pool, o.broker), true);
  assert.deepEqual(o.keys, [KEY]);
});
