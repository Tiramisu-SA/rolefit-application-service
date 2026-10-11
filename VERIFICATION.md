# Local verification

Executed on 2026-10-11 (Asia/Bangkok). Tests use synthetic sample records and trusted internal identity headers; they do not exercise the existing gateway or Supabase authentication.

## Passed checks

- Application: typecheck, production build, 3 unit-test groups, OpenAPI validation, matching producer/consumer JSON Schemas.
- Notification: typecheck, production build, 4 unit-test groups, health OpenAPI validation, event schema compilation.
- Both final Docker images built and started with automatic, repeatable SQL migrations. Nodemailer is locked to a patched 10.1.x release; the production dependency audit reported zero advisories after the update.
- Real local PostgreSQL, RabbitMQ, SMTP, and Mailpit integration completed successfully.
- Ownership isolation, wrong-company writes, missing identity, invalid statuses, missing IDs, concurrent identical updates, and no-op behavior.
- Status/history persistence and preservation of supplied sample resume/match snapshots.
- Injected outbox-insert failure rolled back both status and history.
- Broker downtime allowed a durable status update; outbox recovered and email was sent after restart.
- Consumer downtime retained confirmed events; the inbox caught up after restart.
- Replayed event created one delivery job and did not create another captured email.
- Mandatory unroutable publication was rejected; malformed JSON reached the invalid-event queue.
- Retry exhaustion, permanent rejection, expired-lease recovery, and no fifth send after an interrupted fourth attempt: injected sender outcomes against real PostgreSQL delivery records. Retry timestamps were verified, then advanced by the integration harness to avoid waiting 100 seconds.
- Actual SMTP container outage created a durable retry; restart recovered and sent the email.
- Database outage returned unavailable readiness and failed writes; services recovered after restart.
- Full-stack restart preserved status, delivery records, and captured messages.
- Each service's PostgreSQL user was denied SELECT on the other service's tables.
- Notion pages were created, fetched back without truncation/unknown blocks, and verified. Existing overview service entries and child pages were preserved.
- All five pre-existing Git checkouts remain clean.

The original final integration command transcript is retained as `evidence/local-integration.log` in Application Service; it is not a reconstructed terminal display. Run `npm run test:integration` from Application Service to reproduce it with fresh fixture IDs.

## Published handoff

- [Application Service API](https://app.notion.com/p/3f5f3040ac6681368da0f187775a4e32)
- [Notification Service Events](https://app.notion.com/p/3f5f3040ac6681aa9ffed9a920c0f85b)

## Remaining integration boundaries

Gateway and frontend code changes are outside this task. Real email delivery and hosted PostgreSQL are configurable future steps but have not been deployed or tested here. Local fixtures are not genuine submitted applications. SMTP acceptance is not guaranteed real inbox placement, and a crash after SMTP acceptance can still cause a duplicate. At the time of the integration run, both repositories were local only. The team subsequently created private GitHub repositories; this service is at [https://github.com/Tiramisu-SA/rolefit-application-service](https://github.com/Tiramisu-SA/rolefit-application-service).

## Submission extension (2026-10-11)

- Application typecheck, build, six unit-test groups, and OpenAPI validation passed after adding submission. Upstream schema validators compile and unit tests exercise malformed data/identity mismatches and real gRPC/HTTP transports against labelled contract stubs.
- `npm run test:submission` passed against real local PostgreSQL, RabbitMQ, Notification Service, and Mailpit. It verified rejection without persistence, concurrent submissions (one 201/one 409), one initial history entry, no initial notification event, immutable resume/match/contact readback without upstream calls, seeker/company isolation, initial-history failure rollback, cover-letter persistence, and subsequent status email.
- The existing status-notification outage/recovery integration command passed again with migration 002 applied. Its fixtures use distinct candidate/job pairs to respect the new uniqueness rule.
- Upstream resume/job protocols were copied unchanged from their owning GitHub repositories. Resume is `main`; Job Posting is the documented `dev` contract. Provenance is in `proto/README.md`.
- Submission integration uses four labelled contract stubs. A live run against teammates' running services and gateway/Supabase authentication is still required. No real email provider or hosted deployment was added.

The submission command's original transcript is retained at `evidence/submission-integration.log`.

## Development fallback extension (2026-10-11)

- Application typecheck, build, 13 unit-test groups, and OpenAPI/JSON Schema validation passed. Tests exercise each transport outage, all four unavailable together, recovery to live, explicit per-service modes, unknown/cross-pair IDs, preserved closed-job/deadline/unapproved-resume/auth/HTTP errors, redirects, REST configuration errors, invalid responses and concurrent provenance isolation.
- Non-live configuration is rejected outside `APP_ENV=development` or the dedicated local `application_dev` database. Explicit sample resumes/matches satisfy the same submission contracts. Strict-live operation remains the default.
- The real `rolefit-submission-dev` Compose stack built and passed `npm run test:development`: four controlled unreachable upstream targets selected matching demo data; snapshots/history/provenance were persisted; initial submission created no outbox event; duplicate/cover-letter/ownership checks passed; Application/Notification restart preserved the saved response; a later status change reached the real broker, Notification database, SMTP and Mailpit. The event JSON Schema is unchanged.
- Migration 003 was also applied to the normal stack. `npm run test:submission` passed again, including a strict-live submission with null development provenance. A legacy sample application was read through the normal HTTP service with `development: null`; existing status/history were preserved.
- Application's Notion handoff was updated and fetched back with the four mode settings, isolated database/stack instructions, explicit demo pairs, persisted provenance contract and verified results present. Other service pages/code were not changed for this extension. Notification's checkout remains clean.
- Both test stacks and Docker Desktop were stopped afterward to release memory. Normal and development volumes were preserved. The development integration script removes only records it creates; captured Mailpit email is retained as evidence.

The actual development command output is retained at `evidence/development-integration.log`. Upstream data is deliberately simulated, and gateway/JWT authentication plus live teammate-service integration remain unverified.
