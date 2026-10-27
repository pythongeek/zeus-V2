ALTER TABLE `users` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `phone` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uk_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `uk_users_phone` ON `users` (`phone`);--> statement-breakpoint
CREATE TABLE `verification_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identifier` text NOT NULL,
	`channel` text NOT NULL,
	`code_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_verification_identifier` ON `verification_codes` (`identifier`);
