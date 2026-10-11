import { setTimeout as delay } from "node:timers/promises";
import { createPool, integer } from "./config";
import { Broker } from "./broker";
import { Repository } from "./repository";
import { SubmissionService } from "./submission";
import { developmentConfig, withDevelopmentSources } from "./development";
import { UpstreamClients } from "./upstreams";
import { createApp } from "./app";
import { publishNext } from "./outbox";

// Validate dev-mode restrictions before opening database or broker connections.
developmentConfig();
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
  console.log("Application HTTP listening"),
);
broker.start();
const worker = (async () => {
  while (!stopping) {
    try {
      if (await publishNext(pool, broker)) continue;
    } catch {
      console.error("Outbox pending; will retry");
    }
    await delay(500);
  }
})();
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await broker.stop();
  await worker;
  clients.close();
  await pool.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
