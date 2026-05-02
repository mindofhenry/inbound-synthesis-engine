-- 004_reps_slack_id.sql
-- Add slack_id to reps for n8n workflow DM targeting.
-- Reps 1, 2, 8 seeded with the demo Slack ID; reps 3-7 left NULL (no Slack accounts).

ALTER TABLE reps ADD COLUMN IF NOT EXISTS slack_id text;

UPDATE reps SET slack_id = 'U0ANRG80F2Q' WHERE id IN (1, 2, 8) AND slack_id IS NULL;
