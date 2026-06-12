CREATE TABLE `product_merges` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`change_seq` integer NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`provisional_id` text NOT NULL,
	`master_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_merges_provisional_uq` ON `product_merges` (`provisional_id`);--> statement-breakpoint
CREATE INDEX `product_merges_branch_seq_idx` ON `product_merges` (`branch_code`,`change_seq`);