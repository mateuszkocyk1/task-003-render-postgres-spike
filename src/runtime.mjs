import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";
import { runtimePoolConfig } from "./config.mjs";

const { Pool } = pg;

export function createPgPool(applicationName, max) {
  return new Pool(runtimePoolConfig(applicationName, max));
}

export function createPrisma(applicationName, max) {
  const adapter = new PrismaPg(runtimePoolConfig(applicationName, max));
  return new PrismaClient({ adapter });
}

export async function waitForRuntimeRole(applicationName, maxAttempts = 90) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pool = createPgPool(applicationName, 1);
    try {
      await pool.query("SELECT 1");
      return pool;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw lastError;
}
