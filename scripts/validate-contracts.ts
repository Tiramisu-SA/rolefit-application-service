import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";
import { readFileSync } from "node:fs";
import { validateMatch, validateResume } from "../src/submission";
import { loadService } from "../src/upstreams";
import { validateEvent } from "../src/event";
async function main() {
  await SwaggerParser.validate("openapi.yaml");
  const doc = parse(readFileSync("openapi.yaml", "utf8"));
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validateNullableResume = ajv.compile(
    doc.components.schemas.Application.properties.resumeSnapshot,
  );
  if (!validateNullableResume(null))
    throw new Error("Legacy null resume snapshot must satisfy OpenAPI");
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
  if (!validateResume || !validateMatch)
    throw new Error("Submission schemas did not compile");
  if (
    !loadService("job-posting.proto", "jobposting").service.GetJob ||
    !loadService("resume-preparation.proto", "resumepreparation").service
      .GetApprovedResume
  )
    throw new Error("Required upstream RPC missing");
  console.log(
    "OpenAPI valid; event schemas identical; submission schemas compiled; upstream RPCs loaded; illustrative event valid",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
