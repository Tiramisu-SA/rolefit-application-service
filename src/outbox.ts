import type { Pool } from "pg";
import { Broker, publishConfirmed } from "./broker";

export async function publishNext(
  pool: Pool,
  broker: Broker,
): Promise<boolean> {
  const ch = broker.channel;
  if (!broker.ready || !ch) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT event_id,payload FROM notification_outbox WHERE published_at IS NULL ORDER BY sequence LIMIT 1 FOR UPDATE SKIP LOCKED",
    );
    if (!rows[0]) {
      await client.query("COMMIT");
      return false;
    }
    await publishConfirmed(
      ch,
      Buffer.from(JSON.stringify(rows[0].payload)),
      rows[0].event_id,
    );
    await client.query(
      "UPDATE notification_outbox SET published_at=now() WHERE event_id=$1",
      [rows[0].event_id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await broker.disconnect();
    throw error;
  } finally {
    client.release();
  }
}
