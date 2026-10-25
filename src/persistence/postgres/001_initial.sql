CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  max_upload_bytes BIGINT CHECK(max_upload_bytes>0),
  daily_upload_limit BIGINT CHECK(daily_upload_limit>=0),
  default_upload_profile_id TEXT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
  status TEXT NOT NULL CHECK(status IN ('active','disabled')),
  auth_version BIGINT NOT NULL CHECK(auth_version>0),
  CHECK(role != 'owner' OR status = 'active')
);
CREATE UNIQUE INDEX users_single_owner ON users(role) WHERE role='owner';
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  auth_version BIGINT NOT NULL CHECK(auth_version>0),
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT,
  revoked_at BIGINT,
  name TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  allowed_profile_ids TEXT CHECK(allowed_profile_ids IS NULL OR (allowed_profile_ids::json IS NOT NULL AND json_typeof(allowed_profile_ids::json)='array'))
);
CREATE TABLE plugin_instances (
  max_storage_bytes BIGINT CHECK(max_storage_bytes > 0 AND max_storage_bytes <= 9007199254740991),
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('path','storage','processor')),
  name TEXT NOT NULL,
  stage TEXT CHECK(stage IN ('upload','access','post_save')),
  config_json TEXT NOT NULL CHECK(config_json::json IS NOT NULL),
  config_version BIGINT NOT NULL CHECK(config_version>0),
  config_schema_version BIGINT NOT NULL CHECK(config_schema_version>0),
  secrets_encrypted TEXT,
  secrets_version BIGINT NOT NULL CHECK(secrets_version>0),
  state_json TEXT NOT NULL CHECK(state_json::json IS NOT NULL),
  state_version BIGINT NOT NULL CHECK(state_version>0),
  last_init_error TEXT,
  CHECK((kind='processor' AND stage IS NOT NULL) OR (kind<>'processor' AND stage IS NULL))
);
CREATE TABLE storage_groups (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  name TEXT NOT NULL,
  selection_strategy TEXT NOT NULL CHECK(selection_strategy IN ('priority','weighted_random')),
  replica_count BIGINT NOT NULL CHECK(replica_count>=1),
  config_version BIGINT NOT NULL CHECK(config_version>0)
);
CREATE TABLE storage_group_members (
  group_id TEXT NOT NULL REFERENCES storage_groups(id),
  storage_instance_id TEXT NOT NULL REFERENCES plugin_instances(id),
  priority BIGINT NOT NULL CHECK(priority>=0),
  weight DOUBLE PRECISION NOT NULL CHECK(weight>0 AND weight<=1.7976931348623157e308),
  PRIMARY KEY(group_id,storage_instance_id),
  UNIQUE(group_id,priority)
);
CREATE TABLE pipelines (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('upload','post_save','access')),
  config_version BIGINT NOT NULL CHECK(config_version>0)
);
CREATE UNIQUE INDEX single_access_pipeline ON pipelines(kind) WHERE kind='access';
CREATE TABLE upload_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  name TEXT NOT NULL,
  public_prefix TEXT NOT NULL,
  path_instance_id TEXT NOT NULL UNIQUE REFERENCES plugin_instances(id),
  upload_pipeline_id TEXT REFERENCES pipelines(id),
  post_save_pipeline_id TEXT REFERENCES pipelines(id),
  storage_group_id TEXT NOT NULL REFERENCES storage_groups(id),
  allow_guest_upload BIGINT NOT NULL DEFAULT 0 CHECK(allow_guest_upload IN (0,1)),
  is_default BIGINT NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  enabled BIGINT NOT NULL CHECK(enabled IN (0,1)),
  config_version BIGINT NOT NULL CHECK(config_version>0),
  max_upload_bytes BIGINT CHECK(max_upload_bytes>0),
  allowed_mime_types TEXT NOT NULL CHECK(allowed_mime_types::json IS NOT NULL)
);
CREATE UNIQUE INDEX upload_profiles_single_default ON upload_profiles(is_default) WHERE is_default=1;
CREATE TABLE pipeline_steps (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  enabled_params TEXT NOT NULL CHECK(enabled_params::json IS NOT NULL AND json_typeof(enabled_params::json)='array'),
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  position BIGINT NOT NULL CHECK(position>=0),
  plugin_instance_id TEXT NOT NULL UNIQUE REFERENCES plugin_instances(id),
  on_not_applicable TEXT CHECK(on_not_applicable IS NULL OR on_not_applicable IN ('skip','abort')),
  UNIQUE(pipeline_id,position)
);

CREATE TABLE files (
  processing_results_json TEXT CHECK(processing_results_json IS NULL OR (processing_results_json::json IS NOT NULL AND json_typeof(processing_results_json::json)='array')),
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('upload','import')),
  origin_user_id TEXT REFERENCES users(id),
  guest_ip TEXT,
  upload_profile_id TEXT REFERENCES upload_profiles(id) ON DELETE SET NULL,
  storage_group_id TEXT REFERENCES storage_groups(id) ON DELETE SET NULL,
  public_prefix TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  public_path TEXT,
  mime_type TEXT,
  byte_size BIGINT CHECK(byte_size>=0),
  width BIGINT CHECK(width>0),
  height BIGINT CHECK(height>0),
  status TEXT NOT NULL CHECK(status IN ('preparing','ready','blocked','failed','deleting','delete_failed','deleted')),
  temp_path TEXT,
  temp_status TEXT NOT NULL CHECK(temp_status IN ('available','missing','cleaned')),
  last_error TEXT,
  CHECK((temp_status='cleaned' AND temp_path IS NULL) OR (temp_status<>'cleaned' AND temp_path IS NOT NULL)),
  CHECK(origin_kind <> 'import' OR origin_user_id IS NOT NULL),
  UNIQUE(public_prefix,logical_key)
);
CREATE TABLE file_replicas (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id),
  storage_instance_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','writing','ready','write_failed','delete_pending','deleting','delete_failed','deleted')),
  locator_json TEXT CHECK(locator_json IS NULL OR (locator_json::json IS NOT NULL AND json_typeof(locator_json::json) IN ('string','object'))),
  UNIQUE(file_id,storage_instance_id),
  UNIQUE(id,file_id)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('write','action','delete')),
  file_id TEXT NOT NULL REFERENCES files(id),
  replica_id TEXT,
  pipeline_id TEXT REFERENCES pipelines(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','failed','cancelled')),
  manual_retry BIGINT NOT NULL DEFAULT 0 CHECK(manual_retry IN (0,1)),
  attempts BIGINT NOT NULL CHECK(attempts>=0),
  next_run_at BIGINT,
  last_error TEXT,
  FOREIGN KEY(replica_id,file_id) REFERENCES file_replicas(id,file_id),
  CHECK((kind='action' AND replica_id IS NULL) OR (kind<>'action' AND pipeline_id IS NULL AND replica_id IS NOT NULL)),
  CHECK(status<>'pending' OR next_run_at IS NOT NULL)
);
CREATE UNIQUE INDEX active_replica_task ON tasks(replica_id) WHERE replica_id IS NOT NULL AND status IN ('pending','running','failed');
CREATE UNIQUE INDEX file_action ON tasks(file_id) WHERE kind='action';
CREATE UNIQUE INDEX files_public_path ON files(public_path);
CREATE INDEX file_storage_key ON files(storage_key);
CREATE INDEX file_created ON files(created_at,id);
CREATE INDEX file_owner ON files(owner_id,status,created_at,id);
CREATE INDEX file_status ON files(status,created_at,id);
CREATE INDEX file_group ON files(storage_group_id) WHERE storage_group_id IS NOT NULL;
CREATE INDEX replica_source ON file_replicas(storage_instance_id);
CREATE INDEX replica_status ON file_replicas(file_id,status);
CREATE INDEX task_due ON tasks(status,next_run_at);
CREATE INDEX task_file ON tasks(file_id);
CREATE INDEX task_pipeline ON tasks(pipeline_id);
CREATE INDEX profile_prefix ON upload_profiles(public_prefix);
CREATE INDEX session_user_idx ON sessions(user_id);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE INDEX token_user ON api_tokens(user_id);
CREATE INDEX token_expiry ON api_tokens(expires_at);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  upload_key_hash TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  guest_ip TEXT,
  source_token_id TEXT,
  profile_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  organization_json TEXT NOT NULL CHECK(jsonb_typeof(organization_json::jsonb)='object'),
  params_json TEXT NOT NULL CHECK(params_json::json IS NOT NULL),
  byte_size BIGINT NOT NULL CHECK(byte_size>0),
  part_size BIGINT NOT NULL CHECK(part_size>0),
  status TEXT NOT NULL CHECK(status IN ('pending','completing','completed','failed')),
  file_id TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  CHECK(source_token_id IS NULL OR owner_id IS NOT NULL)
);
CREATE INDEX upload_session_expiry ON upload_sessions(expires_at);

CREATE TABLE user_upload_profiles (
 user_id TEXT NOT NULL REFERENCES users(id),
 upload_profile_id TEXT NOT NULL REFERENCES upload_profiles(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,upload_profile_id)
);

CREATE TABLE daily_upload_usage (
  subject TEXT NOT NULL,
  day TEXT NOT NULL,
  upload_count BIGINT NOT NULL CHECK(upload_count>=0),
  PRIMARY KEY(subject,day)
);
CREATE INDEX daily_upload_day ON daily_upload_usage(day);


CREATE TABLE source_cleanup_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  source_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('delete','detach')),
  include_last INTEGER NOT NULL CHECK(include_last IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('active','finished')),
  removed_item_count BIGINT NOT NULL DEFAULT 0 CHECK(removed_item_count>=0)
);
CREATE UNIQUE INDEX active_source_cleanup ON source_cleanup_jobs(source_id) WHERE status='active';
CREATE INDEX source_cleanup_latest ON source_cleanup_jobs(source_id,created_at,id);
CREATE TABLE source_cleanup_items (
  id TEXT PRIMARY KEY NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  job_id TEXT NOT NULL REFERENCES source_cleanup_jobs(id),
  file_id TEXT NOT NULL REFERENCES files(id),
  replica_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','kept','failed')),
  whole_file INTEGER NOT NULL CHECK(whole_file IN (0,1)),
  error TEXT,
  UNIQUE(job_id,replica_id),
  FOREIGN KEY(replica_id,file_id) REFERENCES file_replicas(id,file_id)
);
CREATE INDEX cleanup_item_status ON source_cleanup_items(job_id,status,created_at,id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX tags_owner_name ON tags(owner_id,name_key);
CREATE TABLE collections (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX collections_owner_name ON collections(owner_id,name_key);
CREATE TABLE file_tags (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(file_id,tag_id)
);
CREATE INDEX file_tags_reverse ON file_tags(tag_id,file_id);
CREATE TABLE collection_files (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY(collection_id,file_id)
);
CREATE INDEX collection_files_reverse ON collection_files(file_id,collection_id);
