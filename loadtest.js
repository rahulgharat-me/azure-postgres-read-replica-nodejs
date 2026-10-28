// Load test through db.js (app -> PgBouncer -> primary/replica). Run: npm run loadtest
// Run it from a VM in the same Azure region/VNet for production-like numbers; from a laptop,
// network round-trip dominates every query.
const SECONDS = Number(process.env.LOADTEST_SECONDS || 10);
const LEVELS = [1, 10, 50, 100, 200];
const ROWS = 100_000;

// Pools as large as the highest concurrency, so the app-side pool isn't the bottleneck
process.env.POSTGRES_POOL_MAX = process.env.POSTGRES_REPLICA_POOL_MAX = String(Math.max(...LEVELS));
process.env.POSTGRES_POOL_CONNECTION_TIMEOUT_MS = '30000';
const { default: db } = await import('./db.js');

const randId = () => 1 + Math.floor(Math.random() * ROWS);
const ops = {
  read: () => db.read('SELECT id, name, points FROM loadtest_members WHERE id = $1', [randId()]),
  write: () => db.write('UPDATE loadtest_members SET points = points + 1 WHERE id = $1', [randId()]),
  transfer: () => db.transaction(async (tx) => {
    const [a, b] = [randId(), randId()].sort((x, y) => x - y); // lock in id order: no deadlocks
    if (a === b) return;
    await tx.query('SELECT 1 FROM loadtest_members WHERE id IN ($1, $2) ORDER BY id FOR UPDATE', [a, b]);
    await tx.query('UPDATE loadtest_members SET points = points - 1 WHERE id = $1', [a]);
    await tx.query('UPDATE loadtest_members SET points = points + 1 WHERE id = $1', [b]);
  }),
  aggregate: () => db.read('SELECT tier, count(*), sum(points) FROM loadtest_members GROUP BY tier'),
};

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

// Runs `concurrency` workers for SECONDS; each picks an op from mix ({ read: 0.8, write: 0.2 })
async function run(concurrency, mix) {
  const entries = Object.entries(mix);
  const latencies = [];
  const errors = {};
  const deadline = Date.now() + SECONDS * 1000;
  const worker = async () => {
    while (Date.now() < deadline) {
      let r = Math.random(), op = entries[0][0];
      for (const [name, weight] of entries) { if ((r -= weight) <= 0) { op = name; break; } }
      const t = performance.now();
      try {
        await ops[op]();
        latencies.push(performance.now() - t);
      } catch (err) {
        errors[err.message] = (errors[err.message] || 0) + 1;
      }
    }
  };
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const secs = (performance.now() - start) / 1000;
  latencies.sort((a, b) => a - b);
  const errCount = Object.values(errors).reduce((a, b) => a + b, 0);
  return {
    concurrency,
    'ops/sec': Math.round(latencies.length / secs),
    ok: latencies.length,
    errors: errCount,
    'p50 ms': Math.round(pct(latencies, 50)),
    'p95 ms': Math.round(pct(latencies, 95)),
    'p99 ms': Math.round(pct(latencies, 99)),
    ...(errCount && { 'first error': Object.keys(errors)[0].slice(0, 60) }),
  };
}

// Transactions committed per server (proves reads land on the replica)
async function commits() {
  const q = 'SELECT xact_commit::bigint AS n FROM pg_stat_database WHERE datname = current_database()';
  const [p, r] = await Promise.all([db.readPrimary(q), db.read(q)]);
  return { primary: Number(p.rows[0].n), replica: Number(r.rows[0].n) };
}

try {
  console.log(`Setting up ${ROWS.toLocaleString()} rows...`);
  await db.write('DROP TABLE IF EXISTS loadtest_members');
  await db.write(`
    CREATE TABLE loadtest_members AS
    SELECT g AS id, 'member_' || g AS name, (ARRAY['silver','gold','platinum'])[1 + g % 3] AS tier, 1000 AS points
    FROM generate_series(1, ${ROWS}) g`);
  await db.write('ALTER TABLE loadtest_members ADD PRIMARY KEY (id), ADD CHECK (points >= 0)');
  await db.write('ANALYZE loadtest_members');
  while (true) { // wait until the replica has the table
    try { if ((await db.read('SELECT count(*)::int AS n FROM loadtest_members')).rows[0].n === ROWS) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  // Network vs database time
  const rtt = [];
  for (let i = 0; i < 20; i++) { const t = performance.now(); await db.read('SELECT 1'); rtt.push(performance.now() - t); }
  rtt.sort((a, b) => a - b);
  const serverMs = async (sql, fn) => {
    const { rows } = await fn(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
    const plan = rows[0]['QUERY PLAN'][0];
    return (plan['Planning Time'] + plan['Execution Time']).toFixed(2);
  };
  console.log(`\nNetwork round trip (SELECT 1): p50 ${Math.round(pct(rtt, 50))} ms`);
  console.log(`Server time, point lookup by id: ${await serverMs('SELECT * FROM loadtest_members WHERE id = 4242', db.read)} ms`);
  console.log(`Server time, aggregate over ${ROWS.toLocaleString()} rows: ${await serverMs('SELECT tier, count(*), sum(points) FROM loadtest_members GROUP BY tier', db.read)} ms`);

  // Open all connections up front so connection setup isn't counted in the first test
  await Promise.all(Array.from({ length: Math.max(...LEVELS) }, () => Promise.all([db.read('SELECT 1'), db.write('SELECT 1')])));

  const before = await commits();
  const suites = [
    ['Reads (replica, lookup by id)', { read: 1 }, LEVELS],
    ['Writes (primary, single-row UPDATE)', { write: 1 }, LEVELS],
    ['Mixed 80% read / 20% write', { read: 0.8, write: 0.2 }, LEVELS],
    ['Transactions (transfer: lock 2 rows + 2 UPDATEs)', { transfer: 1 }, [10, 50, 100]],
    [`Heavy reads (aggregate over ${ROWS.toLocaleString()} rows, replica)`, { aggregate: 1 }, [1, 10, 50]],
  ];
  for (const [title, mix, levels] of suites) {
    console.log(`\n${title}, ${SECONDS}s per level`);
    const results = [];
    for (const c of levels) results.push(await run(c, mix));
    console.table(results);
  }
  const after = await commits();
  console.log('Transactions committed per server during the test:', {
    primary: after.primary - before.primary,
    replica: after.replica - before.replica,
  });
  console.log('Health after test:', await db.health());
} finally {
  await db.write('DROP TABLE IF EXISTS loadtest_members');
  await db.close();
}
