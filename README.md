# TASK 003 Render PostgreSQL/PostGIS spike

Isolated, synthetic-only harness for TASK 003. It creates only the
`task003.fixture_probe` fixture table and fixed database roles
`task003_migrator` and `task003_runtime`.

The Render Blueprint provisions:

- PostgreSQL 18 Free in Frankfurt;
- a Free web process acting only as the migrator fixture;
- a Free web process acting as the runtime web fixture;
- one approved Starter background worker;
- two Render-generated secret groups whose values exist only in Render.

The migrator enables PostGIS with the Render database owner, creates the two
least-privilege roles, runs `prisma migrate deploy` as `task003_migrator`, and
then retains one TLS database session for topology measurement. The web and
worker processes receive no database-owner credential.

`POST /run` on the web fixture executes Prisma CRUD, parameterized spatial SQL,
commit/rollback, row locking, advisory locking, an optimistic concurrency
conflict, runtime-DDL denial, parallel connection pressure, TLS inspection and
WEB/WORKER/MIGRATOR session measurement.

No `.env` file is used. Do not place a database URL or password in this folder.
