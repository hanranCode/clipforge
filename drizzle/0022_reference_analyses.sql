CREATE TABLE `reference_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`source_path` text NOT NULL,
	`ingest` text,
	`cuts` text,
	`frames` text,
	`vision` text,
	`audio` text,
	`structure` text,
	`reference` text,
	`stale_from` text,
	`created_at` integer,
	`updated_at` integer
);
