-- paperclip:migration-compat online_compatible: widens the subject_type check from ('user') to ('user','agent'); the previous release only writes 'user', which the new check admits, and NOT VALID skips the table scan because every existing row already satisfied the narrower check.
-- Reverse (manual): DELETE FROM "connection_grant_members" WHERE "subject_type" = 'agent'; then drop this constraint and re-add it as CHECK ("subject_type" in ('user')).
ALTER TABLE "connection_grant_members" DROP CONSTRAINT "connection_grant_members_subject_type_check";--> statement-breakpoint
ALTER TABLE "connection_grant_members" ADD CONSTRAINT "connection_grant_members_subject_type_check" CHECK ("connection_grant_members"."subject_type" in ('user', 'agent')) NOT VALID;
