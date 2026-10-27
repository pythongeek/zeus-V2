CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`action` text NOT NULL,
	`details` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_user_action` ON `audit_log` (`user_id`,`action`);--> statement-breakpoint
CREATE INDEX `idx_created` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `balances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`currency` text NOT NULL,
	`available` text DEFAULT '0' NOT NULL,
	`locked` text DEFAULT '0' NOT NULL,
	`total_deposited` text DEFAULT '0' NOT NULL,
	`total_withdrawn` text DEFAULT '0' NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uk_user_currency` ON `balances` (`user_id`,`currency`);--> statement-breakpoint
CREATE TABLE `game_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`server_seed` text NOT NULL,
	`server_seed_hash` text NOT NULL,
	`client_seed` text NOT NULL,
	`nonce` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`ended_at` text,
	`total_spins` integer DEFAULT 0 NOT NULL,
	`total_wagered` text DEFAULT '0' NOT NULL,
	`total_won` text DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_user_active` ON `game_sessions` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_seed_hash` ON `game_sessions` (`server_seed_hash`);--> statement-breakpoint
CREATE TABLE `jackpot_pool` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tier` text NOT NULL,
	`seed_amount` text NOT NULL,
	`current_amount` text NOT NULL,
	`contribution_rate` text NOT NULL,
	`last_won_at` text,
	`last_won_by` integer,
	`hit_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jackpot_pool_tier_unique` ON `jackpot_pool` (`tier`);--> statement-breakpoint
CREATE TABLE `spins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`nonce` integer NOT NULL,
	`bet_amount` text NOT NULL,
	`currency` text NOT NULL,
	`reel_positions` text NOT NULL,
	`symbols_shown` text NOT NULL,
	`win_amount` text DEFAULT '0' NOT NULL,
	`win_lines` text,
	`is_big_win` integer DEFAULT false NOT NULL,
	`is_jackpot` integer DEFAULT false NOT NULL,
	`feature_triggered` text DEFAULT 'none' NOT NULL,
	`free_spins_awarded` integer DEFAULT 0 NOT NULL,
	`hash` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uk_session_nonce` ON `spins` (`session_id`,`nonce`);--> statement-breakpoint
CREATE INDEX `idx_user_spins` ON `spins` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_big_wins` ON `spins` (`is_big_win`,`created_at`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`type` text NOT NULL,
	`currency` text NOT NULL,
	`amount` text NOT NULL,
	`fee` text DEFAULT '0' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`tx_hash` text,
	`from_address` text,
	`to_address` text NOT NULL,
	`confirmations` integer DEFAULT 0 NOT NULL,
	`required_confirmations` integer DEFAULT 3 NOT NULL,
	`processed_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_user_tx` ON `transactions` (`user_id`,`type`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tx_hash` ON `transactions` (`tx_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`unionId` text NOT NULL,
	`name` text,
	`email` text,
	`avatar` text,
	`role` text DEFAULT 'user' NOT NULL,
	`wallet_address` text,
	`username` text,
	`nonce` text DEFAULT '' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`createdAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updatedAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`lastSignInAt` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_unionId_unique` ON `users` (`unionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_wallet_address_unique` ON `users` (`wallet_address`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);