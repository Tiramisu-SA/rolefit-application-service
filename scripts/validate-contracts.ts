import SwaggerParser from "@apidevtools/swagger-parser";
import { readFileSync } from "node:fs";
import { validateEvent } from "../src/event";
async function main() {
  await SwaggerParser.validate("openapi.yaml");
  const mine = readFileSync(
    "contracts/application.status.changed.v1.schema.json",
  );
  const consumer = readFileSync(
    "../rolefit-notification-service/contracts/application.status.changed.v1.schema.json",
  );
  if (!mine.equals(consumer))
    throw new Error("Producer/consumer event contracts differ");
  if (
    !validateEvent({
      eventId: "26ec5af5-7cef-434b-9fe9-dc4f37e00455",
      schemaVersion: 1,
      eventType: "application.status.changed.v1",
      occurredAt: "2026-10-11T00:00:00Z",
      applicationId: "sample",
      jobId: "sample-job",
      candidateId: "sample-user",
      recipient: { name: "Sample", email: "sample@example.test" },
      jobTitle: "Sample job",
      previousStatus: "Submitted",
      newStatus: "Under review",
    })
  )
    throw new Error("Event example is invalid");
  console.log(
    "OpenAPI valid; event schemas identical; illustrative event valid",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
