import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),

  // Database
  DATABASE_URL: z.string().url(),

  // Xero
  XERO_CLIENT_ID: z.string().min(1),
  XERO_CLIENT_SECRET: z.string().min(1),
  XERO_REDIRECT_URI: z.string().url(),

  // App
  APP_SECRET: z.string().min(32),

  // Scheduler (cron expressions — set to empty string to disable)
  SYNC_FULL_CRON:        z.string().default("0 2 * * *"),   // nightly 2 AM UTC
  SYNC_INCREMENTAL_CRON: z.string().default("*/20 * * * *"), // every 20 minutes
  SCHEDULER_ENABLED:     z.coerce.boolean().default(true),

  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
