CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`table_name` text,
	`record_id` text,
	`detail_json` text,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `branches` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_hub` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `this_install` (
	`id` integer PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`is_hub` integer DEFAULT false NOT NULL,
	`next_change_seq` integer DEFAULT 0 NOT NULL,
	`installed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "this_install_single_row" CHECK("this_install"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`full_name` text NOT NULL,
	`role` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_uq` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_cash` integer DEFAULT false NOT NULL,
	`is_bank` integer DEFAULT false NOT NULL,
	`parent_id` text,
	`is_system` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_code_uq` ON `accounts` (`code`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`change_seq` integer NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`entry_date` text NOT NULL,
	`narration` text DEFAULT '' NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` text,
	`is_reversed` integer DEFAULT false NOT NULL,
	`reversed_by_entry_id` text
);
--> statement-breakpoint
CREATE INDEX `je_branch_date_idx` ON `journal_entries` (`branch_code`,`entry_date`);--> statement-breakpoint
CREATE INDEX `je_branch_seq_idx` ON `journal_entries` (`branch_code`,`change_seq`);--> statement-breakpoint
CREATE INDEX `je_ref_idx` ON `journal_entries` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `journal_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`account_id` text NOT NULL,
	`party_id` text,
	`debit_paisa` integer DEFAULT 0 NOT NULL,
	`credit_paisa` integer DEFAULT 0 NOT NULL,
	`line_note` text,
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jl_one_side_positive" CHECK("journal_lines"."debit_paisa" >= 0 AND "journal_lines"."credit_paisa" >= 0
          AND NOT ("journal_lines"."debit_paisa" > 0 AND "journal_lines"."credit_paisa" > 0)
          AND ("journal_lines"."debit_paisa" + "journal_lines"."credit_paisa") > 0)
);
--> statement-breakpoint
CREATE INDEX `jl_entry_idx` ON `journal_lines` (`entry_id`);--> statement-breakpoint
CREATE INDEX `jl_account_idx` ON `journal_lines` (`account_id`);--> statement-breakpoint
CREATE INDEX `jl_party_idx` ON `journal_lines` (`party_id`);--> statement-breakpoint
CREATE TABLE `daily_closing` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`change_seq` integer NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`close_date` text NOT NULL,
	`opening_cash_paisa` integer DEFAULT 0 NOT NULL,
	`closing_cash_paisa` integer DEFAULT 0 NOT NULL,
	`closed_by` text,
	`closed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_closing_branch_date_uq` ON `daily_closing` (`branch_code`,`close_date`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`change_seq` integer NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`expense_account_id` text NOT NULL,
	`paid_from_account_id` text,
	`amount_paisa` integer NOT NULL,
	`note` text,
	`spent_date` text NOT NULL,
	`journal_entry_id` text,
	FOREIGN KEY (`expense_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paid_from_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `expenses_branch_date_idx` ON `expenses` (`branch_code`,`spent_date`);--> statement-breakpoint
CREATE INDEX `expenses_branch_seq_idx` ON `expenses` (`branch_code`,`change_seq`);--> statement-breakpoint
CREATE TABLE `parties` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`change_seq` integer NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`phone` text,
	`address` text,
	`opening_balance_paisa` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parties_branch_code_uq` ON `parties` (`branch_code`,`code`);--> statement-breakpoint
CREATE INDEX `parties_kind_idx` ON `parties` (`kind`);--> statement-breakpoint
CREATE INDEX `parties_branch_seq_idx` ON `parties` (`branch_code`,`change_seq`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`change_seq` integer NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`party_id` text NOT NULL,
	`direction` text NOT NULL,
	`amount_paisa` integer NOT NULL,
	`method` text NOT NULL,
	`account_id` text NOT NULL,
	`ref_no` text,
	`paid_date` text NOT NULL,
	`journal_entry_id` text,
	`note` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_branch_date_idx` ON `payments` (`branch_code`,`paid_date`);--> statement-breakpoint
CREATE INDEX `payments_party_idx` ON `payments` (`party_id`);--> statement-breakpoint
CREATE INDEX `payments_branch_seq_idx` ON `payments` (`branch_code`,`change_seq`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`change_seq` integer NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`sku` text,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`category` text,
	`reorder_level_milli` integer DEFAULT 0 NOT NULL,
	`is_provisional` integer DEFAULT false NOT NULL,
	`provisional_origin_branch` text,
	`master_id` text,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `products_name_idx` ON `products` (`name`);--> statement-breakpoint
CREATE INDEX `products_master_idx` ON `products` (`master_id`);--> statement-breakpoint
CREATE INDEX `products_branch_seq_idx` ON `products` (`branch_code`,`change_seq`);--> statement-breakpoint
CREATE TABLE `purchase_items` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`product_id` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_cost_paisa` integer NOT NULL,
	`line_total_paisa` integer NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pi_purchase_idx` ON `purchase_items` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `pi_product_idx` ON `purchase_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`change_seq` integer NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`party_id` text NOT NULL,
	`doc_no` text NOT NULL,
	`doc_date` text NOT NULL,
	`subtotal_paisa` integer DEFAULT 0 NOT NULL,
	`discount_paisa` integer DEFAULT 0 NOT NULL,
	`total_paisa` integer DEFAULT 0 NOT NULL,
	`paid_paisa` integer DEFAULT 0 NOT NULL,
	`journal_entry_id` text,
	`status` text DEFAULT 'posted' NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_branch_docno_uq` ON `purchases` (`branch_code`,`doc_no`);--> statement-breakpoint
CREATE INDEX `purchases_branch_date_idx` ON `purchases` (`branch_code`,`doc_date`);--> statement-breakpoint
CREATE INDEX `purchases_party_idx` ON `purchases` (`party_id`);--> statement-breakpoint
CREATE INDEX `purchases_branch_seq_idx` ON `purchases` (`branch_code`,`change_seq`);--> statement-breakpoint
CREATE TABLE `sale_items` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`product_id` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_price_paisa` integer NOT NULL,
	`unit_cost_paisa` integer NOT NULL,
	`line_total_paisa` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `si_sale_idx` ON `sale_items` (`sale_id`);--> statement-breakpoint
CREATE INDEX `si_product_idx` ON `sale_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `sales` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`change_seq` integer NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`party_id` text,
	`doc_no` text NOT NULL,
	`doc_date` text NOT NULL,
	`subtotal_paisa` integer DEFAULT 0 NOT NULL,
	`discount_paisa` integer DEFAULT 0 NOT NULL,
	`total_paisa` integer DEFAULT 0 NOT NULL,
	`paid_paisa` integer DEFAULT 0 NOT NULL,
	`journal_entry_id` text,
	`status` text DEFAULT 'posted' NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_branch_docno_uq` ON `sales` (`branch_code`,`doc_no`);--> statement-breakpoint
CREATE INDEX `sales_branch_date_idx` ON `sales` (`branch_code`,`doc_date`);--> statement-breakpoint
CREATE INDEX `sales_party_idx` ON `sales` (`party_id`);--> statement-breakpoint
CREATE INDEX `sales_branch_seq_idx` ON `sales` (`branch_code`,`change_seq`);--> statement-breakpoint
CREATE TABLE `stock_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`branch_code` text NOT NULL,
	`change_seq` integer NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`product_id` text NOT NULL,
	`move_type` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_cost_paisa` integer DEFAULT 0 NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`moved_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sm_branch_product_idx` ON `stock_moves` (`branch_code`,`product_id`);--> statement-breakpoint
CREATE INDEX `sm_branch_seq_idx` ON `stock_moves` (`branch_code`,`change_seq`);--> statement-breakpoint
CREATE INDEX `sm_ref_idx` ON `stock_moves` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`file_path` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text NOT NULL,
	`taken_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`peer_branch` text NOT NULL,
	`packet_sha256` text NOT NULL,
	`record_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`peer_branch` text PRIMARY KEY NOT NULL,
	`last_export_seq` integer DEFAULT 0 NOT NULL,
	`last_import_seq` integer DEFAULT 0 NOT NULL,
	`last_export_at` text,
	`last_import_at` text
);
