-- One-time setup, run on the PRIMARY as the admin user (your_admin_user).
-- Roles, databases and role settings replicate to the read replica automatically.
--   psql "host=your-primary.postgres.database.azure.com dbname=postgres user=your_admin_user sslmode=require" -f sql/setup.sql

-- 1. Dedicated app user instead of the server admin
CREATE ROLE app_user WITH LOGIN PASSWORD 'CHANGE_ME_strong_password';

-- 2. Server-side timeouts for the app user. Needed with PgBouncer, which rejects these as connection
--    parameters (db.js sets them per connection only when POSTGRES_PGBOUNCER=false).
ALTER ROLE app_user SET statement_timeout = '30s';
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE app_user SET lock_timeout = '10s';

-- 3. App database owned by the app user (PG16+: admin must be a member of a role to assign ownership to it)
GRANT app_user TO your_admin_user;
CREATE DATABASE app_db OWNER app_user;
GRANT ALL PRIVILEGES ON DATABASE app_db TO app_user;
REVOKE ALL ON DATABASE app_db FROM PUBLIC; -- only app_user (and admins) can connect

-- 4. Inside the new database: the app owns the public schema, so it can create/alter/drop its tables
\c app_db
ALTER SCHEMA public OWNER TO app_user;
GRANT ALL ON SCHEMA public TO app_user;

-- Then in .env:  POSTGRES_USER=app_user  POSTGRES_PASSWORD=<above>  POSTGRES_DB=app_db
-- Rotate the password later with:  ALTER ROLE app_user PASSWORD '<new>';
