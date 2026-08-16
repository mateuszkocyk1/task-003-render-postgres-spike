import pg from "pg";
import { adminPoolConfig, requireEnv } from "./config.mjs";

const { Pool } = pg;

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function upsertLoginRole(client, role, password) {
  const exists = await client.query(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [role],
  );
  if (exists.rows[0].exists) {
    await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${sqlLiteral(password)}`);
  } else {
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD ${sqlLiteral(password)}`);
  }
}

export async function bootstrapDatabase() {
  const pool = new Pool(adminPoolConfig());
  const client = await pool.connect();
  try {
    const version = await client.query(
      "SELECT current_setting('server_version_num')::int AS server_version_num",
    );
    if (version.rows[0].server_version_num < 180000) {
      throw new Error("PostgreSQL 18 or newer is required by TASK 003");
    }

    await client.query("CREATE EXTENSION IF NOT EXISTS postgis");
    await upsertLoginRole(
      client,
      "task003_migrator",
      requireEnv("MIGRATOR_DB_PASSWORD"),
    );
    await upsertLoginRole(
      client,
      "task003_runtime",
      requireEnv("RUNTIME_DB_PASSWORD"),
    );

    const database = await client.query("SELECT current_database() AS name");
    const databaseIdentifier = `"${database.rows[0].name.replaceAll('"', '""')}"`;
    await client.query(`GRANT CONNECT ON DATABASE ${databaseIdentifier} TO task003_migrator`);
    await client.query(`GRANT CONNECT ON DATABASE ${databaseIdentifier} TO task003_runtime`);
    // Render's managed admin role can create login roles, but it is not a member
    // of those roles and therefore cannot transfer schema ownership with SET ROLE.
    // Keep the fixture schema admin-owned and grant only migration-time DDL here.
    await client.query("CREATE SCHEMA IF NOT EXISTS task003");
    await client.query("REVOKE CREATE ON SCHEMA task003 FROM PUBLIC");
    await client.query("GRANT USAGE, CREATE ON SCHEMA task003 TO task003_migrator");
    await client.query("GRANT USAGE ON SCHEMA task003 TO task003_runtime");

    const postgis = await client.query("SELECT PostGIS_Version() AS version");
    return {
      postgresMajor: Math.floor(version.rows[0].server_version_num / 10000),
      postgisVersion: postgis.rows[0].version,
      rolesSeparated: true,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

export async function grantRuntimePrivileges() {
  const pool = new Pool(adminPoolConfig());
  try {
    await pool.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA task003 TO task003_runtime",
    );
    await pool.query(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA task003 TO task003_runtime",
    );
  } finally {
    await pool.end();
  }
}
