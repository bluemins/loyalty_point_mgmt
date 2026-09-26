require("dotenv").config();

const { z } = require("zod");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  APP_NAME: z.string().default("loyalty"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  SESSION_SECRET: z.string().min(16),
  DEMO_TENANT_SLUG: z.string().default("demo"),
  DEMO_TENANT_NAME: z.string().default("Demo Works"),
  MSG91_AUTH_KEY: z.string().optional().or(z.literal("")),
  MSG91_SENDER_ID: z.string().default("LOYALTY"),
  MSG91_TEMPLATE_ID: z.string().default("LOYALTY_OTP")
});

const env = envSchema.parse(process.env);

module.exports = { env, envSchema };
