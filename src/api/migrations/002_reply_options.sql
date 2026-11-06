-- Release 2 (D-009): options shown with each outbound reply, so numbered text answers map back to actions.
ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS options jsonb;
CREATE INDEX IF NOT EXISTS idx_messages_user_latest ON channel_messages(channel, external_user, created_at DESC);
