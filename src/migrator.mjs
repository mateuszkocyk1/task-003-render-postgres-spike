import { spawn } from "node:child_process";
import http from "node:http";
import pg from "pg";
import { bootstrapDatabase, grantRuntimePrivileges } from "./bootstrap.mjs";
import {
  requireEnv,
  roleDatabaseUrl,
  sanitizeText,
  runtimePoolConfig,
} from "./config.mjs";

const { Pool } = pg;
const state = {
  ready: false,
  postgresMajor: null,
  postgisAvailable: false,
  rolesSeparated: false,
  migrationApplied: false,
  tls: false,
  error: null,
};

function runPrismaMigrationCommand(databaseUrl, command) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "prisma", "migrate", ...command], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(sanitizeText(output));
      else reject(new Error(
        `Prisma migrate ${command.join(" ")} failed (${code}): ${sanitizeText(output)}`,
      ));
    });
  });
}

async function resolveKnownFailedFixtureMigration(databaseUrl) {
  const migrationName = "202608160001_task003_fixture";
  const pool = new Pool({
    ...runtimePoolConfig("task003-migration-recovery", 1),
    user: "task003_migrator",
    password: requireEnv("MIGRATOR_DB_PASSWORD"),
  });
  try {
    const historyTable = await pool.query(
      "SELECT to_regclass('task003._prisma_migrations') IS NOT NULL AS exists",
    );
    if (!historyTable.rows[0].exists) return false;
    const failed = await pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM task003._prisma_migrations
          WHERE migration_name = $1
            AND finished_at IS NULL
            AND rolled_back_at IS NULL
       ) AS exists`,
      [migrationName],
    );
    if (!failed.rows[0].exists) return false;
    await runPrismaMigrationCommand(databaseUrl, ["resolve", "--rolled-back", migrationName]);
    return true;
  } finally {
    await pool.end();
  }
}

async function initialize() {
  const bootstrap = await bootstrapDatabase();
  state.postgresMajor = bootstrap.postgresMajor;
  state.postgisAvailable = Boolean(bootstrap.postgisVersion);
  state.rolesSeparated = bootstrap.rolesSeparated;

  const migratorUrl = roleDatabaseUrl(
    "task003_migrator",
    requireEnv("MIGRATOR_DB_PASSWORD"),
    "task003-prisma-migrate",
  );
  await resolveKnownFailedFixtureMigration(migratorUrl);
  await runPrismaMigrationCommand(migratorUrl, ["deploy"]);
  state.migrationApplied = true;
  await grantRuntimePrivileges();

  const pool = new Pool({
    ...runtimePoolConfig("task003-migrator", 1),
    user: "task003_migrator",
    password: requireEnv("MIGRATOR_DB_PASSWORD"),
  });
  const hold = await pool.connect();
  const ssl = await hold.query(
    "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
  );
  state.tls = ssl.rows[0]?.ssl === true;
  state.ready = true;

  const timer = setInterval(() => {
    hold.query("SELECT 1").catch((error) => {
      state.ready = false;
      state.error = sanitizeText(error.message);
    });
  }, 5_000);
  timer.unref();
}

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.statusCode = state.ready ? 200 : 503;
  response.end(JSON.stringify(state));
});

server.listen(Number.parseInt(process.env.PORT ?? "10000", 10), "0.0.0.0");
initialize().catch((error) => {
  state.error = sanitizeText(error.message);
  console.error(`TASK003_MIGRATOR_ERROR ${state.error}`);
});
