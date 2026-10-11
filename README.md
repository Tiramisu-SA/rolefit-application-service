# RoleFit Application Service

Owns persisted applications, recruitment status history, and the transactional notification outbox. This task implements status changes for existing applications; application submission is intentionally absent.

## Local stack

Place this repo beside `rolefit-notification-service`. Requires Node.js 22+ and Docker Desktop. The Compose stack is isolated from the other RoleFit repositories and uses local sample data only.

```sh
npm ci
docker compose up -d --build
docker compose exec application node dist/src/seed.js
npm run validate:contracts
npm test
npm run test:integration
```

Install dependencies in the sibling notification repository before running host-side integration checks: `npm ci` there. The integration command temporarily stops/restarts **only this stack**, creates uniquely named test applications, and cleans up those test records. Run it on this local development stack, not on a shared environment. Retry exhaustion and permanent SMTP rejection use injected sender failures against real PostgreSQL records; successful SMTP delivery and dependency outage/recovery use the real containers.

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

Application trusts `X-User-Id`, `X-User-Role`, and recruiter `X-Company-Id` supplied by an authenticating gateway. These headers are **not authentication credentials**. Direct local test requests exercise authorization only. Deployment must make service ports inaccessible to untrusted callers. The existing gateway has not been modified or integrated by this task.

## Reliability and operations

Status, history, and event are committed in one PostgreSQL transaction. A serial outbox worker publishes persistent messages with mandatory routing and broker confirms; failed/ambiguous publication remains pending. Duplicate events are expected and deduplicated by the notification inbox.

`/health` checks process liveness. `/ready` returns 503 when PostgreSQL cannot be queried. If only RabbitMQ is unavailable it returns 200 with `status: degraded`, allowing status updates to continue. Inspect pending outbox rows and logs for backlog; broker acceptance does not prove SMTP delivery. Run one application publisher process and one notification delivery worker in this prototype. Scaling and per-application delivery ordering are outside this task.

Logs contain event IDs and safe error categories, not tokens, connection strings, recipients, or raw provider responses.

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

`npm run typecheck`, `npm run build`, `npm test`, `npm run validate:contracts`, and `npm run test:integration`. Actual verification results are recorded in `VERIFICATION.md`. Live Supabase/gateway authentication is not covered until the gateway owner integrates the documented contract.
