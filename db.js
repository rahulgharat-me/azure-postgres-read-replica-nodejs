// PostgreSQL primary + read replica for Node.js. Settings come from .env (see .env.example).
//
//   import db from './db.js';
//
//   await db.read('SELECT ...', [params]);         // replica (falls back to primary if replica is down/lagging)
//   await db.readPrimary('SELECT ...', [params]);  // primary: use right after a write to see fresh data
//   await db.write('INSERT ...', [params]);        // primary
//   await db.transaction(async (tx) => {           // primary, all-or-nothing
//     await tx.query('UPDATE ...', [params]);
//   });
import pg from 'pg';

const env = process.env;
const num = (name, fallback) => (env[name] ? Number(env[name]) : fallback);

const pgbouncer = env.POSTGRES_PGBOUNCER === 'true';
const port = num('POSTGRES_PORT', pgbouncer ? 6432 : 5432);
const maxReplicaLagSeconds = num('POSTGRES_MAX_REPLICA_LAG_SECONDS', 5);

const config = {
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB,
  port,
  ssl: { rejectUnauthorized: true }, // Azure requires TLS
  application_name: env.APP_NAME,
  max: num('POSTGRES_POOL_MAX', 10),
  min: num('POSTGRES_POOL_MIN', 2),
  idleTimeoutMillis: num('POSTGRES_POOL_IDLE_TIMEOUT_MS', 30_000),
  connectionTimeoutMillis: num('POSTGRES_POOL_CONNECTION_TIMEOUT_MS', 5_000),
  maxLifetimeSeconds: num('POSTGRES_POOL_MAX_LIFETIME_SECONDS', 1800),
  query_timeout: num('POSTGRES_QUERY_TIMEOUT_MS', 35_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000, // OS default is 2h; Azure drops idle connections after ~4 min
  // PgBouncer rejects this as a connection parameter; with PgBouncer it's set on the DB user (sql/setup.sql)
  ...(!pgbouncer && { statement_timeout: num('POSTGRES_STATEMENT_TIMEOUT_MS', 30_000) }),
};

const primary = new pg.Pool({ ...config, host: env.POSTGRES_HOST });
const replica = env.POSTGRES_REPLICA_HOST
  ? new pg.Pool({
      ...config,
      host: env.POSTGRES_REPLICA_HOST,
      port: num('POSTGRES_REPLICA_PORT', port),
      max: num('POSTGRES_REPLICA_POOL_MAX', config.max),
    })
  : null;

// Without these, a dropped idle connection (Azure maintenance, failover) crashes the process
primary.on('error', (err) => console.error('[db] primary connection error:', err.message));
replica?.on('error', (err) => console.error('[db] replica connection error:', err.message));

// ── Replica health: reads go to primary while the replica is down or lagging ──
let replicaHealthy = Boolean(replica);
let replicaLagSeconds = null;

function markReplica(healthy, reason) {
  if (healthy !== replicaHealthy) {
    console.warn(healthy ? '[db] replica healthy, reads -> replica' : `[db] replica unhealthy (${reason}), reads -> primary`);
  }
  replicaHealthy = healthy;
}

async function checkReplica() {
  try {
    // Lag is 0 when everything received has been replayed
    const { rows: [r] } = await replica.query(`
      SELECT CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
                  ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()) END AS lag`);
    replicaLagSeconds = Number(r.lag ?? 0);
    markReplica(replicaLagSeconds <= maxReplicaLagSeconds, `lag ${replicaLagSeconds}s`);
  } catch (err) {
    markReplica(false, err.message);
  }
}

if (replica) {
  checkReplica();
  setInterval(checkReplica, num('POSTGRES_HEALTH_CHECK_INTERVAL_MS', 15_000)).unref();
}

// Server unreachable, as opposed to a bad query. Not pg-pool's "timeout exceeded when trying to connect",
// which means our own pool is full, not that the server is down.
const isConnectionError = (err) =>
  ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', '57P01', '57P03'].includes(err.code) ||
  String(err.code).startsWith('08') ||
  /Connection terminated/i.test(err.message);

// ── Public API ──

async function read(text, params) {
  if (!replicaHealthy) return primary.query(text, params);
  try {
    return await replica.query(text, params);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    markReplica(false, err.message);
    return primary.query(text, params);
  }
}

const readPrimary = (text, params) => primary.query(text, params);

const write = (text, params) => primary.query(text, params);

// Runs fn(tx) on one primary connection inside BEGIN/COMMIT; any throw rolls back.
// Inside fn use tx.query(), not db.write()/db.read() (those run on other connections).
async function transaction(fn) {
  const client = await primary.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { broken = true; });
    throw err;
  } finally {
    client.release(broken); // a broken connection is discarded instead of reused
  }
}

// For a /health endpoint
async function health() {
  const primaryUp = await primary.query('SELECT 1').then(() => true, () => false);
  const pool = (p) => p && { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount };
  return {
    status: !primaryUp ? 'down' : replica && !replicaHealthy ? 'degraded' : 'ok',
    primary: primaryUp ? 'up' : 'down',
    replica: !replica ? 'not configured' : replicaHealthy ? 'up' : 'unhealthy',
    replicaLagSeconds,
    pools: { primary: pool(primary), replica: pool(replica) },
  };
}

// Call on shutdown (SIGTERM)
const close = () => Promise.all([primary.end(), replica?.end()]);

export default { read, readPrimary, write, transaction, health, close };
