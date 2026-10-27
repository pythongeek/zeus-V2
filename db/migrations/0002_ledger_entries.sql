CREATE TABLE `ledger_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`spin_id` integer,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`amount` text NOT NULL,
	`balance_after` text NOT NULL,
	`createdAt` integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ledger_user` ON `ledger_entries` (`user_id`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `idx_ledger_spin` ON `ledger_entries` (`spin_id`);
