CREATE TABLE `feed_schedule` (
  `id` INTEGER NOT NULL DEFAULT 1,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `interval_minutes` INTEGER NOT NULL DEFAULT 720,
  `last_run_at` DATETIME(3) NULL,
  `last_success_at` DATETIME(3) NULL,
  `next_run_at` DATETIME(3) NULL,
  `last_error` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
