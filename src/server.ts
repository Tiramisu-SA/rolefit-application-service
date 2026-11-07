import { setTimeout as delay } from "node:timers/promises";
import { createPool, integer, reminderConfig } from "./config";
import { Broker } from "./broker";
import { Repository } from "./repository";
import { SubmissionService } from "./submission";
import { developmentConfig, withDevelopmentSources } from "./development";
import { UpstreamClients } from "./upstreams";
import { createApp } from "./app";
import { publishNext } from "./outbox";
import { logger } from "./logger";
import { startReminderScheduler } from "./reminder";

// Validate dev-mode restrictions before opening database or broker connections.
developmentConfig();
const reminders = reminderConfig();
const clients = new UpstreamClients();
const sources = withDevelopmentSources(clients);
const pool = createPool();
const broker = new Broker(
  process.env.RABBITMQ_URL || "amqp://rolefit:rolefit-local@localhost:5672",
);
const repository = new Repository(pool);
let stopping = false;
const server = createApp(
  repository,
  async () => {
    let database = true;
    try {
      await pool.query("SELECT 1");
    } catch {
      database = false;
    }
    return { database, broker: broker.ready };
  },
  new SubmissionService(repository, sources),
).listen(integer("PORT", 3004), process.env.HOST || "0.0.0.0", () =>
  logger.info("Application HTTP listening"),
);
broker.start();
const worker = (async () => {
  while (!stopping) {
    try {
      if (await publishNext(pool, broker)) continue;
    } catch {
      logger.error("Outbox pending; will retry");
    }
    await delay(500);
  }
})();
const stopReminders = reminders.enabled
  ? startReminderScheduler(
      {
        listPublishedJobs: () => clients.listPublishedJobs(),
        listDraftsForJobs: (ids) => clients.listDraftsForJobs(ids),
        hasAppliedOrReminded: (c, j) => repository.hasAppliedOrReminded(c, j),
        getCandidate: (id) => clients.getCandidateForReminder(id),
        recordReminder: (e) => repository.recordReminder(e),
      },
      reminders,
    )
  : () => {};
async function stop() {
  if (stopping) return;
  stopping = true;
  stopReminders();
  server.close();
  await broker.stop();
  await worker;
  clients.close();
  await pool.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
