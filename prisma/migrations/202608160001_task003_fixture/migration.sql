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
