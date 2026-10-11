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

Gateway and frontend changes are outside this task. Real email delivery and hosted PostgreSQL are configurable future steps but have not been deployed or tested here. Local fixtures are not genuine submitted applications. SMTP acceptance is not guaranteed real inbox placement, and a crash after SMTP acceptance can still cause a duplicate. At the time of the integration run, both repositories were local only. The team subsequently created private GitHub repositories; this service is at [https://github.com/Tiramisu-SA/rolefit-application-service](https://github.com/Tiramisu-SA/rolefit-application-service).
