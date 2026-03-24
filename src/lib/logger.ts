/**
 * Structured logger.
 *
 * In production (NODE_ENV=production): emits newline-delimited JSON to stdout
 * so Railway / Datadog / any log aggregator can parse it.
 *
 * In development: emits coloured, human-readable lines to stdout/stderr.
 *
 * Log level filtering:
 *   Set LOG_LEVEL=debug|info|warn|error (default: "info").
 *   Any entry below the configured level is silently dropped.
 *
 * Error serialization:
 *   If the `data` argument is an Error, its message and stack are extracted
 *   so they appear as structured fields rather than "[object Object]".
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLOURS: Record<Level, string> = {
  debug: "\x1b[90m",  // grey
  info:  "\x1b[36m",  // cyan
  warn:  "\x1b[33m",  // yellow
  error: "\x1b[31m",  // red
};
const RESET = "\x1b[0m";

function getMinLevel(): number {
  const raw = process.env.LOG_LEVEL?.toLowerCase() as Level | undefined;
  return LEVELS[raw ?? "info"] ?? LEVELS.info;
}

function serializeData(data: unknown): unknown {
  if (data instanceof Error) {
    return { message: data.message, stack: data.stack, name: data.name };
  }
  return data;
}

function log(level: Level, message: string, data?: unknown): void {
  if (LEVELS[level] < getMinLevel()) return;

  const isError = level === "error" || level === "warn";
  const out = isError ? process.stderr : process.stdout;

  if (process.env.NODE_ENV === "production") {
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      message,
    };
    if (data !== undefined) entry.data = serializeData(data);
    out.write(JSON.stringify(entry) + "\n");
  } else {
    const ts = new Date().toISOString();
    const label = `${COLOURS[level]}${level.toUpperCase().padEnd(5)}${RESET}`;
    const prefix = `\x1b[90m${ts}\x1b[0m ${label} ${message}`;
    if (data !== undefined) {
      out.write(`${prefix} ${JSON.stringify(serializeData(data), null, 0)}\n`);
    } else {
      out.write(`${prefix}\n`);
    }
  }
}

export const logger = {
  debug: (msg: string, data?: unknown) => log("debug", msg, data),
  info:  (msg: string, data?: unknown) => log("info",  msg, data),
  warn:  (msg: string, data?: unknown) => log("warn",  msg, data),
  error: (msg: string, data?: unknown) => log("error", msg, data),
};
