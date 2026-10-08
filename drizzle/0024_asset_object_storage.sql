ALTER TABLE `assets` ADD `object_key` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `object_bucket` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `object_uploaded_at` integer;--> statement-breakpoint
ALTER TABLE `library_assets` ADD `object_key` text;--> statement-breakpoint
ALTER TABLE `library_assets` ADD `object_bucket` text;--> statement-breakpoint
ALTER TABLE `library_assets` ADD `object_uploaded_at` integer;