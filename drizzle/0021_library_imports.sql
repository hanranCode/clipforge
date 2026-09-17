CREATE TABLE `library_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`import_source` text DEFAULT 'upload' NOT NULL,
	`file_path` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`source_url` text,
	`author` text,
	`license` text,
	`size_bytes` integer,
	`width` integer,
	`height` integer,
	`duration_sec` real,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `library_assets_created_at_idx` ON `library_assets` (`created_at`);