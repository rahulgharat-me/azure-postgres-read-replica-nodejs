# Postgres primary + read replica in Node.js

One file, [`db.js`](db.js), for using our Azure PostgreSQL primary and read replica from Node.js with the `pg` driver.

```
             app ── db.write / db.transaction / db.readPrimary ──▶ primary  (your-primary, read-write)
              │                                                      │ replication (async, ~ms)
              └──────────────── db.read ────────────────────────▶ replica  (your-replica, read-only)
```

Azure does **not** split traffic between the servers. `db.js` decides where each query goes.

## Setup

```bash
npm install                 # only dependency: pg
cp .env.example .env        # fill in POSTGRES_PASSWORD
npm run example             # runs example.js against the real servers
```
Requires Node 20.6+. `--env-file` loads `.env`, so the `dotenv` package isn't needed.

## Usage

```js
import db from './db.js';

// Read: replica. Falls back to the primary if the replica is down or lagging > 5 s
const { rows } = await db.read('SELECT * FROM members WHERE tier = $1', ['gold']);

// Write: primary
const { rows: [m] } = await db.write('INSERT INTO members (name) VALUES ($1) RETURNING *', ['Asha']);

// Read right after a write: primary (the replica may be a few ms behind)
await db.readPrimary('SELECT * FROM members WHERE id = $1', [m.id]);

// Several statements that must all succeed or all fail: primary
await db.transaction(async (tx) => {
  await tx.query('UPDATE members SET points = points - $2 WHERE id = $1', [from, 100]);
  await tx.query('UPDATE members SET points = points + $2 WHERE id = $1', [to, 100]);
});

// Health endpoint and shutdown
app.get('/health', async (req, res) => res.json(await db.health()));
process.on('SIGTERM', async () => { await db.close(); process.exit(0); });
```

| Function | Server | Use for |
|---|---|---|
| `db.read(sql, params)` | Replica | Lists, search, detail pages, reports |
| `db.readPrimary(sql, params)` | Primary | Reading data you just wrote; checks before a write |
| `db.write(sql, params)` | Primary | INSERT / UPDATE / DELETE / CREATE |
| `db.transaction(async (tx) => …)` | Primary | Multi-statement changes that must be atomic |
| `db.health()` | Both | `/health` endpoint: `ok` / `degraded` / `down` |
| `db.close()` | Both | Graceful shutdown |

### Rules
- **Always use `$1, $2` parameters** and never build SQL with string concatenation. This prevents SQL injection.
- **Inside `transaction()`, use `tx.query()`.** `db.write()` and `db.read()` run on other connections, outside the transaction.
- **A single statement is already atomic.** For example, `UPDATE ... SET points = points + 1` doesn't need `transaction()`.
- **Keep transactions short.** Don't call HTTP APIs inside one.
- **Never decide a write based on `db.read()`.** For example, check the balance *inside* the transaction with `SELECT ... FOR UPDATE`.
- **PgBouncer (transaction mode) limits:**
  - Don't use session-level `SET` (use `SET LOCAL` inside a transaction).
  - Don't use `LISTEN/NOTIFY`.
  - Don't use session advisory locks.
  - Don't use named prepared statements.

## Configuration (`.env`)

| Variable | Value | Meaning |
|---|---|---|
| `POSTGRES_HOST` / `POSTGRES_REPLICA_HOST` | | Primary / replica hostnames. Leave the replica empty in local dev, and everything goes to the primary. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `app_user` / … / `app_db` | App login (created by [`sql/setup.sql`](sql/setup.sql)), the same on both servers |
| `POSTGRES_PGBOUNCER` | `true` | Connect through Azure's built-in PgBouncer |
| `POSTGRES_PORT` / `POSTGRES_REPLICA_PORT` | `6432` | 6432 = PgBouncer, 5432 = direct |
| `POSTGRES_POOL_MAX` / `POSTGRES_REPLICA_POOL_MAX` | `10` / `20` | Max connections per app instance (reads dominate, so the replica pool is larger) |
| `POSTGRES_POOL_MIN` | `2` | Connections kept open when idle |
| `POSTGRES_POOL_IDLE_TIMEOUT_MS` | `30000` | Close extra idle connections after this |
| `POSTGRES_POOL_CONNECTION_TIMEOUT_MS` | `5000` | Max wait for a connection. Errors here mean the pool is too small. |
| `POSTGRES_POOL_MAX_LIFETIME_SECONDS` | `1800` | Recycle connections, so they rebalance after failover |
| `POSTGRES_QUERY_TIMEOUT_MS` | `35000` | App stops waiting for a query |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | `30000` | Server-side query limit (direct connections only; with PgBouncer it's set on the DB user) |
| `POSTGRES_MAX_REPLICA_LAG_SECONDS` | `5` | Reads switch to the primary above this lag |
| `POSTGRES_HEALTH_CHECK_INTERVAL_MS` | `15000` | How often replica health is checked |
| `APP_NAME` | `my-app` | Shown in `pg_stat_activity` |

## When things go wrong

| Situation | What happens |
|---|---|
| Replica down or lagging | Reads go to the primary automatically. `health()` reports `degraded`. Reads switch back within 15 s of recovery. |
| Write sent through `db.read()` | Fails with `25006` (read-only). It is not retried on the primary, so the bug is visible. |
| `timeout exceeded when trying to connect` | Pool is full. Raise `POSTGRES_POOL_MAX`, or fix slow queries. |
| Query > 30 s | Cancelled by the server |
| Azure drops idle connections | Logged and replaced. The app doesn't crash. |

## Other files
- [`example.js`](example.js): runnable example of every function.
- [`loadtest.js`](loadtest.js): parallel load test (`npm run loadtest`). Results are in [`docs/load-test-report.md`](docs/load-test-report.md).
- [`sql/setup.sql`](sql/setup.sql): how the app database and user were created.
- [`docs/server-config.md`](docs/server-config.md): server parameters and sizing for heavy load.
