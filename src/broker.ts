import amqp, {
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from "amqplib";
import { setTimeout as delay } from "node:timers/promises";

export const EXCHANGE = "rolefit.events";
export const KEY = "application.status.changed.v1";
export const QUEUE = "notification.application-status.v1";
export const DEAD_EXCHANGE = "rolefit.deadletters";
export const DEAD_QUEUE = "notification.invalid.v1";

export async function topology(ch: ConfirmChannel): Promise<void> {
  await ch.assertExchange(EXCHANGE, "topic", { durable: true });
  await ch.assertExchange(DEAD_EXCHANGE, "direct", { durable: true });
  await ch.assertQueue(DEAD_QUEUE, { durable: true });
  await ch.bindQueue(DEAD_QUEUE, DEAD_EXCHANGE, KEY);
  await ch.assertQueue(QUEUE, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": DEAD_EXCHANGE,
      "x-dead-letter-routing-key": KEY,
    },
  });
  await ch.bindQueue(QUEUE, EXCHANGE, KEY);
}

// One publish in flight per channel: basic.return always precedes its confirmation.
export async function publishConfirmed(
  ch: ConfirmChannel,
  payload: Buffer,
  eventId: string,
): Promise<void> {
  let returned = false;
  const onReturn = () => {
    returned = true;
  };
  ch.on("return", onReturn);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Publish confirmation timed out")),
        10000,
      );
      ch.publish(
        EXCHANGE,
        KEY,
        payload,
        {
          persistent: true,
          mandatory: true,
          contentType: "application/json",
          messageId: eventId,
        },
        (error) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else if (returned) reject(new Error("Event was unroutable"));
          else resolve();
        },
      );
    });
  } finally {
    ch.off("return", onReturn);
  }
}

export class Broker {
  ready = false;
  private connection?: ChannelModel;
  channel?: ConfirmChannel;
  private stopped = false;
  private task?: Promise<void>;
  constructor(
    private readonly url: string,
    private readonly onConnected?: (ch: ConfirmChannel) => Promise<void>,
  ) {}
  start(): void {
    this.task = this.run();
  }
  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const connection = await amqp.connect(this.url, { timeout: 3000 });
        this.connection = connection;
        if (this.stopped) {
          await connection.close();
          break;
        }
        connection.on("error", () => {});
        const closed = new Promise<void>((resolve) =>
          connection.once("close", () => {
            this.ready = false;
            this.channel = undefined;
            resolve();
          }),
        );
        const ch = await connection.createConfirmChannel();
        ch.on("error", () => {});
        ch.once("close", () => {
          this.ready = false;
          void connection.close().catch(() => {});
        });
        await topology(ch);
        await ch.prefetch(1);
        if (this.onConnected) await this.onConnected(ch);
        this.channel = ch;
        this.ready = true;
        console.log("RabbitMQ connected");
        await closed;
      } catch {
        this.ready = false;
        this.channel = undefined;
        await this.connection?.close().catch(() => {});
        this.connection = undefined;
        if (!this.stopped) console.error("RabbitMQ unavailable; reconnecting");
      }
      if (!this.stopped) await delay(1000);
    }
  }
  async disconnect(): Promise<void> {
    this.ready = false;
    await this.connection?.close().catch(() => {});
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.disconnect();
    await this.task;
  }
}
export type Message = ConsumeMessage;
