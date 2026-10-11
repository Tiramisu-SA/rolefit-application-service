# Team handoff

The implementation documentation was published directly through the Notion plugin and fetched back to verify it.

- [Application Service API](https://app.notion.com/p/3f5f3040ac6681368da0f187775a4e32)
- [Notification Service Events](https://app.notion.com/p/3f5f3040ac6681aa9ffed9a920c0f85b)
- [RoleFit API Documentation overview](https://app.notion.com/p/3eaf3040ac668190a6b7ece686dd92f4)

Canonical contracts stay in the repositories. Update API.md, contracts, and the corresponding Notion page together. The gateway-owner checklist is on the Application page.

GitHub source: [rolefit-application-service](https://github.com/Tiramisu-SA/rolefit-application-service).

The submission extension adds seeker-only POST, immutable approved resume/match snapshots, and a supplemental Candidate Profile contact lookup. Service-owner handoffs are documented on the Application, Job Discovery, Job Posting, Resume Preparation, and gateway pages. Tests use clearly labelled contract stubs; live team integration remains to be performed.

The Application page also documents the opt-in development modes (`live`, `fallback`, `fixture`), explicit `submission-demo-v1` pairs, isolated `rolefit-submission-dev` stack, persisted `application.development` provenance and unchanged notification event contract. The update was fetched back and checked on 2026-10-11. Local setup: `DEV_FALLBACK.md`; actual transcript: `evidence/development-integration.log`.
