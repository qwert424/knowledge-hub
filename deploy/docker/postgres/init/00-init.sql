-- Idempotent bootstrap for the kh database.
-- Runs once, on a fresh kh_pg_data volume (docker-entrypoint-initdb.d).
-- Business schema is owned by Flyway (backend/platform-boot/src/main/resources/db/migration).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
