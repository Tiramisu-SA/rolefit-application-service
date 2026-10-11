# Development submission without teammates' services

These modes use explicit, synthetic samples. They do not prove live upstream/gateway compatibility, real resume approval, or actual match computation. Production/default operation remains `live`.

## Start the isolated stack

Both stacks publish the same localhost ports, so stop the regular stack first. These commands retain its data:

```sh
docker compose stop
UPSTREAM_MODE=fallback docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

The project is `rolefit-submission-dev`; it has its own PostgreSQL, RabbitMQ, and Mailpit volumes. Application uses `application_dev`, Notification uses `notification_dev`. The normal `rolefit-status` volumes are untouched. Notification sends to this stack's Mailpit on http://localhost:8025. Authentication still belongs to the gateway; the examples below use trusted local test headers only.

Set `UPSTREAM_MODE=fixture` instead when you want immediate samples without trying live services. In `fallback`, the normal `UPSTREAM_TIMEOUT_MS` applies (default 5 seconds per sequential call). There are no extra automatic retries or background submissions. Do not run the regular integration commands against this stack: they target the normal databases. Use `npm run test:development` as described below.

## Modes for each service

| Service            | Environment setting       | Sample provided                                           |
| ------------------ | ------------------------- | --------------------------------------------------------- |
| Job Posting        | `JOB_POSTING_MODE`        | Job title, company, OPEN status, cover-letter requirement |
| Resume Preparation | `RESUME_PREPARATION_MODE` | Explicitly synthetic approved resume sections/bullets     |
| Job Discovery      | `JOB_DISCOVERY_MODE`      | Fixed illustrative score, breakdown and explanation       |
| Candidate Profile  | `CANDIDATE_PROFILE_MODE`  | Demo name and `example.test` email                        |

Each accepts `live`, `fallback`, or `fixture`. `UPSTREAM_MODE` supplies their common default; individual variables override it. The regular Compose stack stays live. The development overlay defaults to fallback unless your shell/ignored `.env` explicitly sets a common mode. For example, keep Job Posting live while simulating the others:

```sh
UPSTREAM_MODE=fixture JOB_POSTING_MODE=live \
  docker compose -f compose.yaml -f compose.dev.yaml up -d application
```

Existing upstream URL settings still control live calls. From containers, use `host.docker.internal` for services on your Mac. A mixed live/fixture request must use a documented demo pair and valid corresponding live resources; fallback does not manufacture those resources in teammates' databases.

Fallback occurs on connection failure or timeout only. Explicit HTTP errors (including 503/504/429), REST redirects/configuration/TLS validation errors, authentication/permission errors, missing resources, closed jobs, expired deadlines, unapproved resumes, and malformed responses keep their usual errors. An HTTP success whose body disconnects or times out before completion counts as transport failure; an invalid completed body fails validation. gRPC UNAVAILABLE/DEADLINE_EXCEEDED/CANCELLED are availability failures. `fixture` mode intentionally skips its live lookup.

## Explicit demo pairs

| Candidate ID                           | Job ID          | Recruiter company | Cover letter |
| -------------------------------------- | --------------- | ----------------- | ------------ |
| `11111111-1111-4111-8111-111111111111` | `job_dev_alpha` | `co-dev-alpha`    | Optional     |
| `22222222-2222-4222-8222-222222222222` | `job_dev_beta`  | `co-dev-beta`     | Required     |

Candidate Alpha uses `demo-alpha@example.test`; Beta uses `demo-beta@example.test`. Both job titles and resume contents are labelled demo/illustrative. Dataset `submission-demo-v1` is defined in `src/development-fixtures.ts`; it contains only these two pairs. Cross-pair or unknown identities/jobs are not substituted. In fallback mode an unknown pair retains the original service error; direct fixture mode returns 503 `DEV_FIXTURE_NOT_FOUND`.

Illustrative submission command (direct internal development headers, no Supabase/gateway authentication):

```sh
curl -i http://localhost:3004/api/applications \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: 11111111-1111-4111-8111-111111111111' \
  -H 'X-User-Role: seeker' \
  -H 'Authorization: Bearer local-demo-token' \
  --data '{"jobId":"job_dev_alpha"}'
```

The sample bearer token only works for direct fixture calls; a live service may reject it, and fallback will preserve that rejection. Submission still enforces seeker identity, body validation, cover letters, one application per candidate/job, atomic initial history, and no initial notification. Repeating this successful submission returns 409 `ALREADY_APPLIED`; do not reset records automatically.

## Saved labels

An illustrative all-fixture application contains:

```json
{
  "development": {
    "fixtureSet": "submission-demo-v1",
    "sources": {
      "jobPosting": "fixture",
      "resumePreparation": "fixture",
      "jobDiscovery": "fixture",
      "candidateProfile": "fixture"
    }
  }
}
```

This object is inside `application`, persisted alongside snapshots/history, and returned by all application read/update responses. It survives restarts and does not change when a dependency recovers. An enabled development request that used every live response has null `fixtureSet` and four `live` labels. Strict-live and legacy applications have `development: null`. Modes cannot be selected by request headers or body fields. Logs name only the selected fixture source; they do not print bearer tokens or contact details. Notification events do not gain resume, match or provenance fields.

Startup rejects non-live modes unless `APP_ENV=development` and `DATABASE_URL` points to `application_dev` on local host `localhost`, `127.0.0.1`, `::1`, or Compose `postgres`. Database provisioning is performed only by this local overlay, and migration 003 adds nullable provenance without changing existing rows. For host Node use the dev infrastructure, set those variables plus the usual local connection URLs, run `npm run migrate`, and stop the container Application before `npm run dev` to free port 3004. There is no authentication or storage fallback.

## Verification and stopping

For a controlled fallback verification, run the development Application with unreachable upstream targets (port 59999). The test checks this configuration, refuses existing demo applications, and cleans up only records it created. Install host dependencies in both sibling repositories first.

```sh
UPSTREAM_MODE=fallback UPSTREAM_TIMEOUT_MS=200 \
JOB_POSTING_GRPC_URL=host.docker.internal:59999 \
RESUME_PREPARATION_GRPC_URL=host.docker.internal:59999 \
JOB_DISCOVERY_SERVICE_URL=http://host.docker.internal:59999 \
CANDIDATE_PROFILE_SERVICE_URL=http://host.docker.internal:59999 \
  docker compose -f compose.yaml -f compose.dev.yaml up -d --build
npm run test:development
```

Unit tests also check each individual outage, live recovery, mixed modes, preserved business errors and concurrent request labels. The Docker test uses real PostgreSQL/broker/SMTP, but deliberately simulated upstream data. Results belong in `VERIFICATION.md` after an actual run.

Stop without deleting data:

```sh
docker compose -f compose.yaml -f compose.dev.yaml stop
```

Use the same two files when restarting this stack. To return to the normal stack, stop this one and run `docker compose up -d`. Keep the development overlay out of hosted deployment.
