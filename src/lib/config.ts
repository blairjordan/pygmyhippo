import { z } from "zod"

const envSchema = z.object({
  DATABASE_URL: z.url(),
  HIPPO_HOST: z.string().default("127.0.0.1"),
  HIPPO_PORT: z.coerce.number().int().positive().default(3000),
  HIPPO_WORKER_ID: z.string().default("hippo-worker"),
  HIPPO_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  HIPPO_LEASE_MS: z.coerce.number().int().positive().default(15_000),
})

export type HippoConfig = z.infer<typeof envSchema>

export const getConfig = (): HippoConfig => envSchema.parse(process.env)
