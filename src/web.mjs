import http from "node:http";
import { createPgPool, createPrisma, waitForRuntimeRole } from "./runtime.mjs";

const state = {
  ready: false,
  initializationError: null,
  lastRun: null,
};

let pool;
let stressPool;
let observerPool;
let prisma;

async function initialize() {
  const readinessPool = await waitForRuntimeRole("task003-web-readiness");
  await readinessPool.end();
  pool = createPgPool("task003-web-pg", 2);
  stressPool = createPgPool("task003-web-stress", 4);
  observerPool = createPgPool("task003-web-observer", 1);
  prisma = createPrisma("task003-web-prisma", 4);
  await pool.query("SELECT 1 FROM task003.fixture_probe LIMIT 1");
  await prisma.$connect();
  state.ready = true;
}

async function sslUsed(client) {
  const result = await client.query(
    "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
  );
  return result.rows[0]?.ssl === true;
}

async function runPostgisAndPrisma() {
  await prisma.fixtureProbe.deleteMany({
    where: { label: { startsWith: "task003-" } },
  });

  const prismaRecord = await prisma.fixtureProbe.create({
    data: { label: "task003-prisma", counter: 3 },
  });
  const prismaRead = await prisma.fixtureProbe.findUnique({
    where: { label: "task003-prisma" },
  });

  const longitude = 21.0122;
  const latitude = 52.2297;
  await prisma.$executeRaw`
    INSERT INTO task003.fixture_probe (label, counter, location)
    VALUES (
      ${"task003-spatial"},
      0,
      ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography
    )
  `;
  const distanceRows = await prisma.$queryRaw`
    SELECT
      ST_DWithin(
        location,
        ST_SetSRID(ST_MakePoint(${21.0130}, ${52.2300}), 4326)::geography,
        ${1000}
      ) AS within_radius,
      ST_Distance(
        location,
        ST_SetSRID(ST_MakePoint(${21.0130}, ${52.2300}), 4326)::geography
      ) AS distance_meters,
      ST_Covers(
        ST_GeomFromText(
          ${"POLYGON((20.99 52.21,21.04 52.21,21.04 52.25,20.99 52.25,20.99 52.21))"},
          4326
        ),
        location::geometry
      ) AS covered
    FROM task003.fixture_probe
    WHERE label = ${"task003-spatial"}
  `;
  const postgis = await prisma.$queryRaw`SELECT PostGIS_Version() AS version`;

  return {
    prismaCreateRead: prismaRecord.id === prismaRead?.id,
    parameterizedRawSql: distanceRows.length === 1,
    withinRadius: distanceRows[0].within_radius,
    covered: distanceRows[0].covered,
    distanceMeters: Math.round(Number(distanceRows[0].distance_meters)),
    postgisVersion: postgis[0].version,
  };
}

async function runTransactions() {
  const committed = await prisma.$transaction(async (tx) => tx.fixtureProbe.create({
    data: { label: "task003-commit", counter: 1 },
  }));
  let rollbackRaised = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.fixtureProbe.create({
        data: { label: "task003-rollback", counter: 1 },
      });
      throw new Error("intentional rollback fixture");
    });
  } catch {
    rollbackRaised = true;
  }
  const rolledBackCount = await prisma.fixtureProbe.count({
    where: { label: "task003-rollback" },
  });
  return {
    commitPersisted: committed.label === "task003-commit",
    rollbackRaised,
    rollbackRemovedWrite: rolledBackCount === 0,
  };
}

async function runRowLock() {
  const row = await prisma.fixtureProbe.create({
    data: { label: "task003-row-lock" },
  });
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query("BEGIN");
    await second.query("BEGIN");
    await first.query(
      "SELECT id FROM task003.fixture_probe WHERE id = $1 FOR UPDATE",
      [row.id],
    );
    const started = Date.now();
    const blockedUpdate = second.query(
      "UPDATE task003.fixture_probe SET counter = counter + 1 WHERE id = $1",
      [row.id],
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await first.query("COMMIT");
    await blockedUpdate;
    const blockedMs = Date.now() - started;
    await second.query("COMMIT");
    return { blockedMs, contentionObserved: blockedMs >= 250 };
  } catch (error) {
    await first.query("ROLLBACK").catch(() => {});
    await second.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    first.release();
    second.release();
  }
}

async function runAdvisoryLock() {
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    const acquired = await first.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [3003],
    );
    const rejected = await second.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [3003],
    );
    await first.query("SELECT pg_advisory_unlock($1)", [3003]);
    return {
      firstAcquired: acquired.rows[0].acquired,
      secondRejected: rejected.rows[0].acquired === false,
    };
  } finally {
    first.release();
    second.release();
  }
}

async function runControlledConflict() {
  const row = await prisma.fixtureProbe.create({
    data: { label: "task003-optimistic-conflict" },
  });
  const attempt = () => pool.query(
    `UPDATE task003.fixture_probe
       SET counter = counter + 1, version = version + 1
     WHERE id = $1 AND version = 0`,
    [row.id],
  );
  const [first, second] = await Promise.all([attempt(), attempt()]);
  return {
    winnerCount: first.rowCount + second.rowCount,
    exactlyOneWinner: first.rowCount + second.rowCount === 1,
  };
}

async function verifyRuntimeCannotDdl() {
  try {
    await pool.query("CREATE TABLE task003.runtime_forbidden_fixture(id int)");
    await pool.query("DROP TABLE task003.runtime_forbidden_fixture");
    return false;
  } catch (error) {
    return error.code === "42501";
  }
}

async function runParallelConnections(count = 24) {
  let peak = 0;
  let monitoring = true;
  const monitor = (async () => {
    while (monitoring) {
      const result = await observerPool.query(
        `SELECT count(*)::int AS count
           FROM pg_stat_activity
          WHERE application_name LIKE 'task003-%'`,
      );
      peak = Math.max(peak, result.rows[0].count);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  const started = Date.now();
  await Promise.all(
    Array.from({ length: count }, () => stressPool.query("SELECT pg_sleep(0.12)")),
  );
  monitoring = false;
  await monitor;
  return { count, elapsedMs: Date.now() - started, peakSpikeConnections: peak };
}

async function connectionMeasurements() {
  const [settings, activity, ssl, role] = await Promise.all([
    pool.query(
      `SELECT
         current_setting('max_connections')::int AS max_connections,
         current_setting('superuser_reserved_connections')::int AS superuser_reserved_connections`,
    ),
    pool.query(
      `SELECT application_name, count(*)::int AS count
         FROM pg_stat_activity
        WHERE application_name LIKE 'task003-%'
        GROUP BY application_name
        ORDER BY application_name`,
    ),
    pool.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"),
    pool.query(
      `SELECT
         current_user = 'task003_runtime' AS runtime_role,
         has_schema_privilege(current_user, 'task003', 'CREATE') AS can_create,
         has_schema_privilege(current_user, 'task003', 'USAGE') AS can_use`,
    ),
  ]);
  const byApplication = Object.fromEntries(
    activity.rows.map((row) => [row.application_name, row.count]),
  );
  return {
    maxConnections: settings.rows[0].max_connections,
    superuserReservedConnections: settings.rows[0].superuser_reserved_connections,
    byApplication,
    webPresent: Object.keys(byApplication).some((name) => name.startsWith("task003-web-")),
    workerPresent: Boolean(byApplication["task003-worker"]),
    migratorPresent: Boolean(byApplication["task003-migrator"]),
    tls: ssl.rows[0]?.ssl === true,
    runtimeRoleSeparated: role.rows[0].runtime_role,
    runtimeCanCreate: role.rows[0].can_create,
    runtimeCanUse: role.rows[0].can_use,
  };
}

async function runSuite() {
  const client = await pool.connect();
  const tls = await sslUsed(client);
  client.release();
  const result = {
    executedAt: new Date().toISOString(),
    tls,
    postgisAndPrisma: await runPostgisAndPrisma(),
    transactions: await runTransactions(),
    rowLock: await runRowLock(),
    advisoryLock: await runAdvisoryLock(),
    controlledConflict: await runControlledConflict(),
    runtimeDdlDenied: await verifyRuntimeCannotDdl(),
    parallel: await runParallelConnections(),
    connections: await connectionMeasurements(),
  };
  state.lastRun = result;
  return result;
}

function send(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/health") {
      send(response, state.ready ? 200 : 503, {
        ready: state.ready,
        error: state.initializationError,
      });
      return;
    }
    if (request.url === "/results") {
      send(response, state.lastRun ? 200 : 404, state.lastRun ?? { available: false });
      return;
    }
    if (request.url === "/run" && request.method === "POST") {
      if (!state.ready) {
        send(response, 503, { error: "not ready" });
        return;
      }
      send(response, 200, await runSuite());
      return;
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    send(response, 500, { error: error.message, code: error.code ?? null });
  }
});

server.listen(Number.parseInt(process.env.PORT ?? "10000", 10), "0.0.0.0");
initialize().catch((error) => {
  state.initializationError = error.message;
  console.error(`TASK003_WEB_INITIALIZATION_ERROR ${error.message}`);
});
