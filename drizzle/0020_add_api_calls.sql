CREATE TABLE `api_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`model_type` text NOT NULL,
	`scene` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`base_url` text,
	`endpoint` text,
	`project_id` text,
	`shot_id` integer,
	`status` text DEFAULT 'success' NOT NULL,
	`http_status` integer,
	`latency_ms` integer,
	`streamed` integer DEFAULT false NOT NULL,
	`request` text,
	`response` text,
	`usage` text,
	`cost` text,
	`error` text,
	`task_id` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `api_calls_created_at_idx` ON `api_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `api_calls_model_type_idx` ON `api_calls` (`model_type`);--> statement-breakpoint
CREATE INDEX `api_calls_project_id_idx` ON `api_calls` (`project_id`);