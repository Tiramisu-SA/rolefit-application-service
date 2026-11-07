export type LogLine = Record<string, unknown>;

export interface CapturedLogs {
  /** Every captured line that is a JSON object; other output is ignored. */
  lines: () => LogLine[];
  /** Resolves with the first matching line. Rejects if none appears: the log is written just after the response. */
  waitFor: (matches: (line: LogLine) => boolean) => Promise<LogLine>;
}

function parse(raw: string): LogLine | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as LogLine) : null;
  } catch {
    return null;
  }
}

/** Replaces the console while `fn` runs, so a test can assert on what the service really logged. */
export async function withCapturedLogs(
  fn: (logs: CapturedLogs) => Promise<void>,
): Promise<void> {
  const raw: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const capture = (...args: unknown[]) => {
    raw.push(args.join(" "));
  };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;

  const lines = () =>
    raw.map(parse).filter((line): line is LogLine => line !== null);
  const waitFor = async (matches: (line: LogLine) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = lines().find(matches);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`No matching log line. Saw:\n${raw.join("\n")}`);
  };

  try {
    await fn({ lines, waitFor });
  } finally {
    Object.assign(console, originals);
  }
}
