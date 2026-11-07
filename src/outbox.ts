import type { Pool } from "pg";
import { Broker, publishConfirmed } from "./broker";
import { logger } from "./logger";

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
      "SELECT event_id,payload,request_id FROM notification_outbox WHERE published_at IS NULL ORDER BY sequence LIMIT 1 FOR UPDATE SKIP LOCKED",
    );
    if (!rows[0]) {
      await client.query("COMMIT");
      return false;
    }
    // Null for events stored before request ids were recorded.
    const requestId: string | undefined = rows[0].request_id ?? undefined;
    await publishConfirmed(
      ch,
      Buffer.from(JSON.stringify(rows[0].payload)),
      rows[0].event_id,
      requestId,
    );
    await client.query(
      "UPDATE notification_outbox SET published_at=now() WHERE event_id=$1",
      [rows[0].event_id],
    );
    await client.query("COMMIT");
    logger.info("event published", { requestId, eventId: rows[0].event_id });
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await broker.disconnect();
    throw error;
  } finally {
    client.release();
  }
}
