CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  max_upload_bytes INTEGER CHECK(max_upload_bytes>0),
  daily_upload_limit INTEGER CHECK(daily_upload_limit>=0),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
  status TEXT NOT NULL CHECK(status IN ('active','disabled')),
  auth_version INTEGER NOT NULL CHECK(auth_version>0),
  CHECK(role != 'owner' OR status = 'active')
);
CREATE UNIQUE INDEX users_single_owner ON users(role) WHERE role='owner';
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  auth_version INTEGER NOT NULL CHECK(auth_version>0),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER,
  revoked_at INTEGER,
  name TEXT NOT NULL,
  token_hint TEXT NOT NULL,
  allowed_profile_ids TEXT CHECK(allowed_profile_ids IS NULL OR (json_valid(allowed_profile_ids) AND json_type(allowed_profile_ids)='array'))
);
CREATE TABLE plugin_instances (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('path','storage','processor')),
  name TEXT NOT NULL,
  stage TEXT CHECK(stage IN ('upload','access','post_save')),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  config_version INTEGER NOT NULL CHECK(config_version>0),
  config_schema_version INTEGER NOT NULL CHECK(config_schema_version>0),
  secrets_encrypted TEXT,
  secrets_version INTEGER NOT NULL CHECK(secrets_version>0),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  state_version INTEGER NOT NULL CHECK(state_version>0),
  last_init_error TEXT,
  CHECK((kind='processor' AND stage IS NOT NULL) OR (kind<>'processor' AND stage IS NULL))
);
CREATE TABLE storage_groups (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  primary_strategy TEXT NOT NULL CHECK(primary_strategy IN ('priority','weighted_random')),
  redundancy_strategy TEXT NOT NULL CHECK(redundancy_strategy IN ('priority','weighted_random')),
  redundancy_count INTEGER NOT NULL CHECK(redundancy_count>=0),
  config_version INTEGER NOT NULL CHECK(config_version>0)
);
CREATE TABLE storage_group_members (
  group_id TEXT NOT NULL REFERENCES storage_groups(id),
  storage_instance_id TEXT NOT NULL REFERENCES plugin_instances(id),
  priority INTEGER NOT NULL CHECK(priority>=0),
  weight REAL NOT NULL CHECK(weight>0 AND weight<=1.7976931348623157e308),
  PRIMARY KEY(group_id,storage_instance_id),
  UNIQUE(group_id,priority)
);
CREATE TABLE pipelines (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('upload','post_save','access')),
  config_version INTEGER NOT NULL CHECK(config_version>0)
);
CREATE UNIQUE INDEX single_access_pipeline ON pipelines(kind) WHERE kind='access';
CREATE TABLE upload_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  public_prefix TEXT NOT NULL,
  path_instance_id TEXT NOT NULL UNIQUE REFERENCES plugin_instances(id),
  upload_pipeline_id TEXT REFERENCES pipelines(id),
  post_save_pipeline_id TEXT REFERENCES pipelines(id),
  storage_group_id TEXT NOT NULL REFERENCES storage_groups(id),
  allow_guest_upload INTEGER NOT NULL DEFAULT 0 CHECK(allow_guest_upload IN (0,1)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  config_version INTEGER NOT NULL CHECK(config_version>0),
  max_upload_bytes INTEGER NOT NULL CHECK(max_upload_bytes>0),
  allowed_mime_types TEXT NOT NULL CHECK(json_valid(allowed_mime_types))
);
CREATE TABLE pipeline_steps (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  enabled_params TEXT NOT NULL CHECK(json_valid(enabled_params) AND json_type(enabled_params)='array'),
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position>=0),
  plugin_instance_id TEXT NOT NULL UNIQUE REFERENCES plugin_instances(id),
  on_not_applicable TEXT CHECK(on_not_applicable IS NULL OR on_not_applicable IN ('skip','abort')),
  UNIQUE(pipeline_id,position)
);

CREATE TABLE files (
  processing_results_json TEXT CHECK(processing_results_json IS NULL OR (json_valid(processing_results_json) AND json_type(processing_results_json)='array')),
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  owner_id TEXT REFERENCES users(id),
  guest_ip TEXT,
  upload_profile_id TEXT REFERENCES upload_profiles(id) ON DELETE SET NULL,
  storage_group_id TEXT REFERENCES storage_groups(id) ON DELETE SET NULL,
  public_prefix TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER CHECK(byte_size>=0),
  width INTEGER CHECK(width>0),
  height INTEGER CHECK(height>0),
  status TEXT NOT NULL CHECK(status IN ('preparing','ready','blocked','failed','deleting','deleted')),
  temp_path TEXT,
  temp_status TEXT NOT NULL CHECK(temp_status IN ('available','missing','cleaned')),
  last_error TEXT,
  deleted_at INTEGER,
  CHECK((temp_status='cleaned' AND temp_path IS NULL) OR (temp_status<>'cleaned' AND temp_path IS NOT NULL)),
  CHECK((status='deleted' AND deleted_at IS NOT NULL) OR (status<>'deleted' AND deleted_at IS NULL)),
  UNIQUE(public_prefix,logical_key)
);
CREATE TABLE file_replicas (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id),
  storage_instance_id TEXT NOT NULL REFERENCES plugin_instances(id),
  role TEXT NOT NULL CHECK(role IN ('primary','redundant')),
  status TEXT NOT NULL CHECK(status IN ('pending','writing','ready','write_failed','write_unknown','delete_pending','deleting','delete_failed','delete_unknown','deleted','cancelled')),
  locator_json TEXT CHECK(locator_json IS NULL OR (json_valid(locator_json) AND json_type(locator_json) IN ('text','object'))),
  UNIQUE(file_id,storage_instance_id),
  UNIQUE(id,file_id)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('write','action','delete')),
  file_id TEXT NOT NULL REFERENCES files(id),
  replica_id TEXT,
  pipeline_id TEXT REFERENCES pipelines(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','failed','cancelled')),
  attempts INTEGER NOT NULL CHECK(attempts>=0),
  next_run_at INTEGER,
  last_error TEXT,
  FOREIGN KEY(replica_id,file_id) REFERENCES file_replicas(id,file_id),
  CHECK((kind='action' AND replica_id IS NULL) OR (kind<>'action' AND pipeline_id IS NULL AND replica_id IS NOT NULL)),
  CHECK(status<>'pending' OR next_run_at IS NOT NULL)
);
CREATE UNIQUE INDEX primary_replica ON file_replicas(file_id) WHERE role='primary';
CREATE UNIQUE INDEX active_replica_task ON tasks(replica_id) WHERE replica_id IS NOT NULL AND status IN ('pending','running','failed');
CREATE UNIQUE INDEX file_action ON tasks(file_id) WHERE kind='action';
CREATE INDEX file_owner ON files(owner_id,status,created_at,id);
CREATE INDEX file_status ON files(status,created_at,id);
CREATE INDEX file_group ON files(storage_group_id) WHERE storage_group_id IS NOT NULL;
CREATE INDEX replica_status ON file_replicas(file_id,status);
CREATE INDEX task_due ON tasks(status,next_run_at);
CREATE INDEX task_file ON tasks(file_id);
CREATE INDEX task_pipeline ON tasks(pipeline_id);
CREATE INDEX profile_prefix ON upload_profiles(public_prefix);
CREATE INDEX session_user ON sessions(user_id);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE INDEX token_user ON api_tokens(user_id);
CREATE INDEX token_expiry ON api_tokens(expires_at);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  upload_key_hash TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id),
  guest_ip TEXT,
  source_token_id TEXT,
  profile_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK(json_valid(params_json)),
  byte_size INTEGER NOT NULL CHECK(byte_size>0),
  part_size INTEGER NOT NULL CHECK(part_size>0),
  status TEXT NOT NULL CHECK(status IN ('pending','completing','completed','failed')),
  file_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
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
  upload_count INTEGER NOT NULL CHECK(upload_count>=0),
  PRIMARY KEY(subject,day)
);
CREATE INDEX daily_upload_day ON daily_upload_usage(day);
