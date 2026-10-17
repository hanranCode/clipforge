CREATE TABLE `reference_cloud_copies` (
	`id` text PRIMARY KEY NOT NULL,
	`content_md5` text NOT NULL,
	`endpoint` text NOT NULL,
	`bucket` text NOT NULL,
	`object_key` text NOT NULL,
	`object_url` text NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `library_assets` ADD `content_md5` text;--> statement-breakpoint
ALTER TABLE `library_assets` ADD `object_endpoint` text;--> statement-breakpoint
ALTER TABLE `library_assets` ADD `object_url` text;--> statement-breakpoint
CREATE UNIQUE INDEX `library_assets_content_md5_idx` ON `library_assets` (`content_md5`);