CREATE TABLE `user_limits` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`deposit_limit_daily` text,
	`loss_limit_daily` text,
	`session_limit_minutes` integer,
	`self_excluded_until` integer DEFAULT 0 NOT NULL,
	`play_started_at` integer DEFAULT 0 NOT NULL,
	`last_spin_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
