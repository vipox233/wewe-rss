CREATE TABLE "feed_schedule" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "interval_minutes" INTEGER NOT NULL DEFAULT 720,
  "last_run_at" DATETIME,
  "last_success_at" DATETIME,
  "next_run_at" DATETIME,
  "last_error" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
