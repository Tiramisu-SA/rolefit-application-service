import { AppError, type Caller } from "./repository";
import type { SubmissionDevelopment, SubmissionSources } from "./submission";
import { developmentFixture, DEV_FIXTURE_SET } from "./development-fixtures";
import { UpstreamUnavailableError } from "./upstreams";

export type UpstreamMode = "live" | "fallback" | "fixture";
export type SourceName = keyof SubmissionDevelopment["sources"];
export interface DevelopmentConfig {
  modes: Record<SourceName, UpstreamMode>;
  enabled: boolean;
}
const modeVariables = {
  jobPosting: "JOB_POSTING_MODE",
  resumePreparation: "RESUME_PREPARATION_MODE",
  jobDiscovery: "JOB_DISCOVERY_MODE",
  candidateProfile: "CANDIDATE_PROFILE_MODE",
} as const;
export function developmentConfig(
  env: NodeJS.ProcessEnv = process.env,
): DevelopmentConfig {
  const mode = (value: string | undefined): UpstreamMode => {
    const result = value ?? "live";
    if (!["live", "fallback", "fixture"].includes(result))
      throw new Error("Invalid upstream mode");
    return result as UpstreamMode;
  };
  const common = mode(env.UPSTREAM_MODE);
  const modes = Object.fromEntries(
    Object.entries(modeVariables).map(([key, variable]) => [
      key,
      mode(env[variable] ?? common),
    ]),
  ) as DevelopmentConfig["modes"];
  const enabled = Object.values(modes).some((value) => value !== "live");
  if (enabled) {
    if (env.APP_ENV !== "development")
      throw new Error("Fixture/fallback modes require APP_ENV=development");
    if (!env.DATABASE_URL) throw new Error("Development database is required");
    const url = new URL(env.DATABASE_URL);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]", "postgres"].includes(url.hostname) ||
      url.pathname !== "/application_dev"
    )
      throw new Error(
        "Fixture/fallback modes require the separate local application_dev database",
      );
  }
  return { modes, enabled };
}

export function withDevelopmentSources(
  live: SubmissionSources,
  env: NodeJS.ProcessEnv = process.env,
): SubmissionSources {
  const config = developmentConfig(env);
  if (!config.enabled) return live;
  // A new context per submission prevents concurrent requests sharing source labels.
  return {
    getJob: live.getJob.bind(live),
    getApprovedResume: live.getApprovedResume.bind(live),
    getMatchResult: live.getMatchResult.bind(live),
    getCandidate: live.getCandidate.bind(live),
    forSubmission(jobId: string, caller: Caller): SubmissionSources {
      const development: SubmissionDevelopment = {
        fixtureSet: null,
        sources: {
          jobPosting: "live",
          resumePreparation: "live",
          jobDiscovery: "live",
          candidateProfile: "live",
        },
      };
      const fixture = developmentFixture(jobId, caller.userId);
      const resolve = async <T>(
        source: SourceName,
        request: () => Promise<T>,
        sample: () => T,
      ): Promise<T> => {
        const mode = config.modes[source];
        if (mode !== "fixture") {
          try {
            return await request();
          } catch (error) {
            if (
              mode !== "fallback" ||
              !(error instanceof UpstreamUnavailableError) ||
              !fixture
            )
              throw error;
          }
        }
        if (!fixture)
          throw new AppError(
            503,
            "DEV_FIXTURE_NOT_FOUND",
            "No development fixture exists for this candidate/job pair",
          );
        development.fixtureSet = DEV_FIXTURE_SET;
        development.sources[source] = "fixture";
        console.info(`Development fixture selected: ${source}`);
        return sample();
      };
      return {
        development,
        getJob: (id, identity, token) =>
          resolve(
            "jobPosting",
            () => live.getJob(id, identity, token),
            () => fixture!.job,
          ),
        getApprovedResume: (id, identity, token) =>
          resolve(
            "resumePreparation",
            () => live.getApprovedResume(id, identity, token),
            () => fixture!.resume,
          ),
        getMatchResult: (id, identity, token) =>
          resolve(
            "jobDiscovery",
            () => live.getMatchResult(id, identity, token),
            () => fixture!.match,
          ),
        getCandidate: (identity, token) =>
          resolve(
            "candidateProfile",
            () => live.getCandidate(identity, token),
            () => fixture!.candidate,
          ),
      };
    },
  };
}
