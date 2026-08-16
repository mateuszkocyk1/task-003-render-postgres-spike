import { waitForRuntimeRole } from "./runtime.mjs";

async function main() {
  const pool = await waitForRuntimeRole("task003-worker", 180);
  const client = await pool.connect();
  console.log("TASK003_WORKER_READY");
  const timer = setInterval(() => {
    client.query("SELECT 1").catch((error) => {
      console.error(`TASK003_WORKER_HEARTBEAT_ERROR ${error.code ?? "UNKNOWN"}`);
    });
  }, 5_000);
  timer.unref();
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(`TASK003_WORKER_ERROR ${error.code ?? "UNKNOWN"}`);
  process.exitCode = 1;
});
