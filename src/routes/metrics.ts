import type { FastifyPluginAsync } from "fastify"

import type { HippoMetrics } from "../lib/metrics.js"

export const createMetricsRoutes = (
  metrics: HippoMetrics
): FastifyPluginAsync => async (app) => {
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType)
    return metrics.registry.metrics()
  })
}
