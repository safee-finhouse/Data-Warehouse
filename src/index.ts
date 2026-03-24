import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { xeroRoutes } from "./modules/xero/xero.routes.js";
import { syncRoutes } from "./modules/sync/sync.routes.js";
import { transformRoutes } from "./modules/transform/transform.routes.js";
import { manualInputsRoutes } from "./modules/manual-inputs/manual-inputs.routes.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";
import { startScheduler } from "./scheduler.js";

async function bootstrap() {
  const app = Fastify({
    logger: false, // we use our own logger
    trustProxy: true,
  });

  await app.register(sensible);

  // Routes
  await app.register(healthRoutes);
  await app.register(xeroRoutes, { prefix: "/xero" });
  await app.register(syncRoutes, { prefix: "/sync" });
  await app.register(transformRoutes, { prefix: "/transform" });
  await app.register(manualInputsRoutes);
  await app.register(adminRoutes, { prefix: "/admin" });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info(`Server listening on port ${env.PORT}`, { env: env.NODE_ENV });

  startScheduler();
}

bootstrap().catch((err) => {
  logger.error("Failed to start server", err);
  process.exit(1);
});
