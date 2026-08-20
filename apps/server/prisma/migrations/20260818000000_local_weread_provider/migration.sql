ALTER TABLE `accounts`
  ADD COLUMN `provider` VARCHAR(32) NOT NULL DEFAULT 'remote';

CREATE TABLE `account_sessions` (
  `account_id` VARCHAR(255) NOT NULL,
  `data` LONGTEXT NOT NULL,
  `last_renew_at` DATETIME(3) NULL,
  `next_renew_at` DATETIME(3) NULL,
  `last_error_code` VARCHAR(64) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`account_id`),
  CONSTRAINT `account_sessions_account_id_fkey`
    FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
