PRAGMA foreign_keys=ON;
/* Rerunning the installer adds to an existing table each column below that it lacks, so a new column allows NULL or has a default (scripts/install.mjs). */
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE, platform_admin INTEGER NOT NULL DEFAULT 0 CHECK(platform_admin IN(0,1)),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN(0,1)), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, apps_limit INTEGER NOT NULL DEFAULT 5,
  awake_limit INTEGER NOT NULL DEFAULT 2, requests_limit INTEGER NOT NULL DEFAULT 10000,
  storage_limit INTEGER NOT NULL DEFAULT 52428800, created_at INTEGER NOT NULL,
  ephemeral_limit INTEGER NOT NULL DEFAULT 3
);
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN('admin','member')), PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT NOT NULL UNIQUE, hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id), label TEXT NOT NULL, scopes_json TEXT NOT NULL,
  app_ids_json TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);
/* origin holds the AppId: databases from per-app domains keep this NOT NULL UNIQUE column (ADR 0044). */
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  owner_id TEXT NOT NULL REFERENCES users(id), origin TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, create_key TEXT NOT NULL, storage_bytes INTEGER NOT NULL DEFAULT 10485760,
  observed_status TEXT NOT NULL DEFAULT 'draft', observed_runtime TEXT NOT NULL DEFAULT 'asleep',
  observed_release INTEGER, observed_at INTEGER, purged_at INTEGER,
  expires_at INTEGER, manager_name TEXT, manager_url TEXT,
  UNIQUE(tenant_id,create_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS app_name ON apps(name) WHERE purged_at IS NULL;
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id), actor_hash TEXT NOT NULL,
  digest TEXT NOT NULL, bytes INTEGER NOT NULL, manifest_json TEXT NOT NULL, generation INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ticket_expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS compute (
  app_id TEXT PRIMARY KEY REFERENCES apps(id), boot_id TEXT NOT NULL, started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_usage (
  tenant_id TEXT NOT NULL REFERENCES tenants(id), day TEXT NOT NULL, requests INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,day)
);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL, tenant_id TEXT,
  app_id TEXT, action TEXT NOT NULL, result TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_tenant_at ON audit(tenant_id,at);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY, slot INTEGER NOT NULL, count INTEGER NOT NULL);
