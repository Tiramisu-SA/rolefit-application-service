import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../contracts/application.status.changed.v1.schema.json";

export const STATUSES = [
  "Submitted",
  "Under review",
  "Interview",
  "Offer",
  "Rejected",
] as const;
export type Status = (typeof STATUSES)[number];
export interface StatusEvent {
  eventId: string;
  schemaVersion: 1;
  eventType: "application.status.changed.v1";
  occurredAt: string;
  applicationId: string;
  jobId: string;
  candidateId: string;
  recipient: { name: string; email: string };
  jobTitle: string;
  previousStatus: Status;
  newStatus: Status;
}
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
export const validateEvent = ajv.compile<StatusEvent>(schema);
