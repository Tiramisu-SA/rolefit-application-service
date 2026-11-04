# RoleFit Application Service

Owns persisted applications, recruitment status history, and the transactional notification outbox. Implements submission for seekers, reads for owning seekers/recruiter companies, and status changes with RabbitMQ notifications.

## Local stack

Place this repo beside `rolefit-notification-service`. Requires Node.js 22+ and Docker Desktop. The Compose stack is isolated from the other RoleFit repositories and uses local sample data only.

```sh
npm ci
docker compose up -d --build
docker compose exec application node dist/src/seed.js
npm run validate:contracts
npm test
npm run test:integration
npm run test:submission
```

Install dependencies in the sibling notification repository before running host-side integration checks: `npm ci` there. The integration command temporarily stops/restarts **only this stack**, creates uniquely named test applications, and cleans up those test records. Run it on this local development stack, not on a shared environment. Retry exhaustion and permanent SMTP rejection use injected sender failures against real PostgreSQL records; successful SMTP delivery and dependency outage/recovery use the real containers.

The status-only stack can run without upstream services. Strict-live submission requires the documented Job Posting, Resume Preparation, Job Discovery, and Candidate Profile APIs. An opt-in, isolated development stack supports per-service `live`, `fallback`, and `fixture` modes; see [DEV_FALLBACK.md](DEV_FALLBACK.md). The regular stack defaults to live calls.

The seed command inserts two labelled sample applications starting at `Submitted`; rerunning it does not reset status/history. Resume and match snapshots are null in these fixtures, not fabricated. Seeds produce no notifications. Integration emails remain in Mailpit as evidence.

| Component                | Local address                                          |
| ------------------------ | ------------------------------------------------------ |
| Application HTTP         | `http://localhost:3004`                                |
| Notification health HTTP | `http://localhost:3005`                                |
| Mailpit inbox            | `http://localhost:8025`                                |
| Mailpit SMTP             | `localhost:1025`                                       |
| RabbitMQ                 | `localhost:5672`                                       |
| RabbitMQ management      | `http://localhost:15672` (`rolefit` / `rolefit-local`) |
| PostgreSQL               | `localhost:5433`                                       |

Compose publishes development ports on `127.0.0.1` only. Application and notification use distinct PostgreSQL databases and users on one local server. Neither can query the other's tables. Development-only passwords in Compose must be replaced for deployment.

Stop with `docker compose stop`; start again with `docker compose up -d`. Volumes retain databases, queued events, and captured email. `docker compose down` also retains volumes. Do not use `down -v` unless you intend to erase this stack's data.

## Run Node locally

Start infrastructure with `docker compose up -d postgres rabbitmq mailpit`, copy `.env.example` to `.env`, then run `npm run migrate`, `npm run seed`, and `npm run dev`. Stop the container version of Application first to avoid port 3004 conflict. `npm run build && npm start` runs compiled Node code; migrations remain an explicit step outside Compose.

## Contracts and gateway integration

Read [API.md](API.md). `openapi.yaml` is OpenAPI 3.0.3 encoded as JSON (valid YAML). The canonical event schema is `contracts/application.status.changed.v1.schema.json`, included verbatim in Notification's repository. Update both copies together and validate them.

Application trusts `X-User-Id`, `X-User-Role`, and recruiter `X-Company-Id` supplied by an authenticating gateway. These headers are **not authentication credentials**. Direct local test requests exercise authorization only. Deployment must make service ports inaccessible to untrusted callers. Gateway/frontend code is owned separately. The gateway must add seeker-only `POST /api/applications` and preserve the verified bearer token; see the handoff in API.md.

## Reliability and operations

Status, history, and event are committed in one PostgreSQL transaction. A serial outbox worker publishes persistent messages with mandatory routing and broker confirms; failed/ambiguous publication remains pending. Duplicate events are expected and deduplicated by the notification inbox.

`/health` checks process liveness. `/ready` returns 503 when PostgreSQL cannot be queried. If only RabbitMQ is unavailable it returns 200 with `status: degraded`, allowing status updates to continue. Inspect pending outbox rows and logs for backlog; broker acceptance does not prove SMTP delivery. Run one application publisher process and one notification delivery worker in this prototype. Scaling and per-application delivery ordering are outside this task.

Logs contain event IDs and safe error categories, not tokens, connection strings, recipients, or raw provider responses.

Logs are JSON, one object per line. Each carries the `requestId` from the gateway's `X-Request-Id` header, which is also sent to every upstream (HTTP header or gRPC `x-request-id` metadata). A status change stores the id in `notification_outbox.request_id`, and the worker publishes it as the AMQP correlation id, so one request can be followed into the Notification Service. The event payload and its contract are unchanged. `/health` and `/ready` are not logged.

## Hosted PostgreSQL later

Provision a dedicated database/user for Application and a separate database/user for Notification. Configure `DATABASE_URL`, `DATABASE_SSL=true`, and, if required, `DATABASE_CA_FILE`. Certificate verification stays enabled. Use `npm run migrate` for each database. Migration versions are recorded and protected by an advisory lock. Moving existing local records requires a deliberate dump/restore; changing the URL alone does not copy data. No Supabase client or shared database access is needed.

## GitHub repositories

Clone both private repositories as siblings so the shared Compose build can find Notification Service:

```sh
git clone https://github.com/Tiramisu-SA/rolefit-application-service.git
git clone https://github.com/Tiramisu-SA/rolefit-notification-service.git
```

Each service has its own Git history. No existing service repository is modified.

## Checks

`npm run typecheck`, `npm run build`, `npm test`, `npm run validate:contracts`, `npm run test:integration`, and `npm run test:submission`. `npm run test:development` verifies the separate fallback stack (see its setup instructions). Actual verification results are recorded in `VERIFICATION.md`. Live Supabase/gateway authentication is not covered until the gateway owner integrates the documented contract.

## Submission dependencies

Host Node defaults: Job Posting gRPC `localhost:50052`, Resume Preparation gRPC `localhost:50053`, Job Discovery HTTP `localhost:3002`, Candidate Profile HTTP `localhost:3001`. The Docker Application container uses `host.docker.internal` for these services running on your Mac. Override the URLs in an ignored `.env` for Compose, using addresses reachable **from inside the container**; `localhost` there means the Application container itself. If services run in another Docker project, connect them through a private network and use service hostnames. Compose does not start teammates' services or provision their databases.

Use the Job Posting owner's documented `dev` contract (not its older default `main` protocol), and Resume Preparation's `main` contract. Copies and Git blob provenance are in `proto/README.md`. Match response details are in API.md and `contracts/match-result.v1.schema.json`.

Run `npm run test:submission` after the local stack is up. It uses **real PostgreSQL, RabbitMQ, Notification, and Mailpit**, with labelled local gRPC/HTTP **contract stubs** for the four upstream APIs. It checks the new submit/read flow, concurrent duplicate prevention, rollback, snapshots, ownership, cover letters, and subsequent email notifications. It does not claim compatibility tested against running teammate services or real Supabase/gateway authentication.

Migration `002_application_submission.sql` adds nullable resume content/cover letters and enforces one application per candidate/job. Existing rows/history are preserved. If historic duplicate pairs exist, migration fails visibly; inspect and resolve them explicitly rather than deleting data automatically.

Local port coordination: the published Job Discovery REST port and Job Posting HTTP health default both use 3002. Keep Discovery on 3002 and configure Job Posting's health-only listener with `HTTP_PORT=3012` (its gRPC address stays 50052), or agree another unused health port with its owner. This task does not change either service's configuration.
