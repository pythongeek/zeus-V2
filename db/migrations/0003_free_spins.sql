ALTER TABLE `game_sessions` ADD COLUMN `free_spins_remaining` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `game_sessions` ADD COLUMN `free_spins_bet` text;
--> statement-breakpoint
ALTER TABLE `game_sessions` ADD COLUMN `free_spins_currency` text;
--> statement-breakpoint
ALTER TABLE `spins` ADD COLUMN `is_free_spin` integer DEFAULT 0 NOT NULL;
