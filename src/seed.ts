import type { Pool } from "pg";
import { createPool } from "./config";
export async function seed(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [id, jobId, companyId, candidateId, title] of [
      [
        "app_demo_brightline",
        "job_seed_frontend",
        "co-brightline",
        "seeker-demo",
        "Frontend Engineer (sample)",
      ],
      [
        "app_demo_harbor",
        "job_seed_harbor_junior",
        "co-harbor",
        "seeker-other",
        "Junior Engineer (sample)",
      ],
    ]) {
      const result = await client.query(
        `INSERT INTO applications(id,job_id,company_id,candidate_id,candidate,job_snapshot,status)
    VALUES ($1,$2,$3,$4,$5,$6,'Submitted') ON CONFLICT(id) DO NOTHING RETURNING id,submitted_at`,
        [
          id,
          jobId,
          companyId,
          candidateId,
          {
            id: candidateId,
            name: "Sample candidate",
            email: `${candidateId}@example.test`,
          },
          { id: jobId, title, companyId },
        ],
      );
      if (result.rows[0])
        await client.query(
          "INSERT INTO application_status_history(application_id,status,at,changed_by) VALUES ($1,'Submitted',$2,'local-seed')",
          [id, result.rows[0].submitted_at],
        );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
if (require.main === module) {
  const pool = createPool();
  seed(pool)
    .then(() =>
      console.log("Sample applications seeded; existing records preserved"),
    )
    .catch(() => {
      console.error("Seed failed");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
