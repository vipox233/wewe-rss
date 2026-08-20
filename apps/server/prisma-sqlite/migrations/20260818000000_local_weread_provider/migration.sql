ALTER TABLE "accounts" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'remote';

CREATE TABLE "account_sessions" (
  "account_id" TEXT NOT NULL PRIMARY KEY,
  "data" TEXT NOT NULL,
  "last_renew_at" DATETIME,
  "next_renew_at" DATETIME,
  "last_error_code" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_sessions_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
