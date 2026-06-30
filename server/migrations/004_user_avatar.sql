-- User profile photo (avatar). Stored as a small base64 data URL on the user row — the same
-- "binary in Postgres" approach the bug tracker uses for screenshots. The image is resized
-- client-side before upload, and the upload route caps the payload, so the column stays small.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
