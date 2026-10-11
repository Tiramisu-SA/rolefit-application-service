import type {
  ApprovedResume,
  MatchResult,
  SubmissionData,
  SubmissionJob,
} from "./submission";

export const DEV_FIXTURE_SET = "submission-demo-v1";
export interface DevelopmentFixture {
  job: SubmissionJob;
  candidate: SubmissionData["candidate"];
  resume: ApprovedResume;
  match: MatchResult;
}
// Explicit synthetic pairs only. These IDs are never substituted into a real response.
const at = "2026-10-11T00:00:00Z";
export const DEVELOPMENT_FIXTURES: readonly DevelopmentFixture[] = [
  {
    job: {
      id: "job_dev_alpha",
      title: "Demo Frontend Engineer",
      companyId: "co-dev-alpha",
      status: "OPEN",
      requireCoverLetter: false,
    },
    candidate: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Demo Candidate Alpha",
      email: "demo-alpha@example.test",
    },
    resume: {
      draftId: "draft_dev_alpha",
      candidateId: "11111111-1111-4111-8111-111111111111",
      jobId: "job_dev_alpha",
      format: "personal",
      approvedAt: at,
      updatedAt: at,
      sections: [
        {
          id: "summary",
          kind: "summary",
          title: "Demo summary",
          meta: "Illustrative development fixture",
          emphasized: false,
          bullets: [
            {
              id: "summary-0",
              text: "Synthetic approved resume for local development.",
              tailored: false,
            },
          ],
        },
      ],
    },
    match: {
      jobId: "job_dev_alpha",
      candidateId: "11111111-1111-4111-8111-111111111111",
      score: 70,
      breakdown: { skills: 70, experience: 70, education: 70, preferences: 70 },
      matchedSkills: ["React"],
      missingSkills: ["TypeScript"],
      strengths: ["Illustrative React experience"],
      gaps: ["Illustrative TypeScript gap"],
      explanation:
        "Fixed illustrative development match, not a computed assessment.",
      computedAt: at,
    },
  },
  {
    job: {
      id: "job_dev_beta",
      title: "Demo Backend Engineer",
      companyId: "co-dev-beta",
      status: "OPEN",
      requireCoverLetter: true,
    },
    candidate: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Demo Candidate Beta",
      email: "demo-beta@example.test",
    },
    resume: {
      draftId: "draft_dev_beta",
      candidateId: "22222222-2222-4222-8222-222222222222",
      jobId: "job_dev_beta",
      format: "company",
      approvedAt: at,
      updatedAt: at,
      sections: [
        {
          id: "skills",
          kind: "skills",
          title: "Demo skills",
          meta: "Illustrative development fixture",
          emphasized: true,
          bullets: [
            {
              id: "skills-0",
              text: "Synthetic Node.js and PostgreSQL experience.",
              tailored: true,
            },
          ],
        },
      ],
    },
    match: {
      jobId: "job_dev_beta",
      candidateId: "22222222-2222-4222-8222-222222222222",
      score: 60,
      breakdown: { skills: 60, experience: 60, education: 60, preferences: 60 },
      matchedSkills: ["Node.js"],
      missingSkills: ["Redis"],
      strengths: ["Illustrative database experience"],
      gaps: ["Illustrative Redis gap"],
      explanation:
        "Fixed illustrative development match, not a computed assessment.",
      computedAt: at,
    },
  },
];
export function developmentFixture(
  jobId: string,
  candidateId: string,
): DevelopmentFixture | undefined {
  const value = DEVELOPMENT_FIXTURES.find(
    (x) => x.job.id === jobId && x.candidate.id === candidateId,
  );
  return value ? structuredClone(value) : undefined;
}
