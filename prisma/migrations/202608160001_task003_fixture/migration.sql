CREATE TABLE "task003"."fixture_probe" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "location" geography(Point, 4326),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fixture_probe_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fixture_probe_label_key"
    ON "task003"."fixture_probe"("label");

CREATE INDEX "fixture_probe_location_gist"
    ON "task003"."fixture_probe" USING GIST ("location");

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE "task003"."fixture_probe"
    TO task003_runtime;

GRANT USAGE, SELECT
    ON SEQUENCE "task003"."fixture_probe_id_seq"
    TO task003_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA "task003"
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO task003_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA "task003"
    GRANT USAGE, SELECT ON SEQUENCES TO task003_runtime;
