ALTER TABLE files ADD COLUMN public_path TEXT;
CREATE UNIQUE INDEX files_public_path ON files(public_path);
