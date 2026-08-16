const REQUIRED_RUNTIME_ENV = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "RUNTIME_DB_PASSWORD",
];

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function assertRuntimeEnv() {
  for (const name of REQUIRED_RUNTIME_ENV) requireEnv(name);
}

export function runtimePoolConfig(applicationName, max) {
  assertRuntimeEnv();
  return {
    host: requireEnv("DB_HOST"),
    port: Number.parseInt(requireEnv("DB_PORT"), 10),
    database: requireEnv("DB_NAME"),
    user: "task003_runtime",
    password: requireEnv("RUNTIME_DB_PASSWORD"),
    application_name: applicationName,
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  };
}

export function roleDatabaseUrl(role, password, applicationName) {
  assertRuntimeEnv();
  const url = new URL("postgresql://placeholder/");
  url.username = role;
  url.password = password;
  url.hostname = requireEnv("DB_HOST");
  url.port = requireEnv("DB_PORT");
  url.pathname = `/${encodeURIComponent(requireEnv("DB_NAME"))}`;
  url.searchParams.set("sslmode", "require");
  url.searchParams.set("schema", "task003");
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

export function adminPoolConfig() {
  return {
    connectionString: requireEnv("ADMIN_DATABASE_URL"),
    application_name: "task003-admin-bootstrap",
    max: 1,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  };
}

export function sanitizeText(text) {
  let result = String(text);
  const values = [
    process.env.ADMIN_DATABASE_URL,
    process.env.RUNTIME_DB_PASSWORD,
    process.env.MIGRATOR_DB_PASSWORD,
    process.env.DB_HOST,
    process.env.DB_NAME,
  ].filter(Boolean);
  for (const value of values) result = result.split(value).join("[REDACTED]");
  result = result.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]");
  return result;
}
