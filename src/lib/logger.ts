import { env } from "../config/env.js";

type Level = "debug" | "info" | "warn" | "error";

function log(level: Level, message: string, data?: unknown) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(data !== undefined ? { data } : {}),
  };

  if (env.NODE_ENV === "production") {
    // Structured JSON for log aggregators (Railway, Datadog, etc.)
    process.stdout.write(JSON.stringify(entry) + "\n");
  } else {
    const prefix = `[${entry.time}] ${level.toUpperCase().padEnd(5)}`;
    console.log(`${prefix} ${message}`, data !== undefined ? data : "");
  }
}

export const logger = {
  debug: (msg: string, data?: unknown) => log("debug", msg, data),
  info: (msg: string, data?: unknown) => log("info", msg, data),
  warn: (msg: string, data?: unknown) => log("warn", msg, data),
  error: (msg: string, data?: unknown) => log("error", msg, data),
};
