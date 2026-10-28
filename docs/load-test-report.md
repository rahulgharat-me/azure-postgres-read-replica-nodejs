# Load test report: Azure PostgreSQL primary + read replica

**Date:** 2026-10-28
**Script:** [`loadtest.js`](../loadtest.js) (`npm run loadtest`)
**Result:** ✅ The database handles parallel load with **0 errors in ~52,000 operations** at up to 200 concurrent workers. Read/write routing works under load. The replica stayed healthy, with 0 s lag after the test.

## Setup

| | |
|---|---|
| Primary | `your-primary`, PostgreSQL 18.6, 8 GiB RAM (about 2 vCores, inferred from server settings) |
| Replica | `your-replica`, same size, async streaming replication |
| Connection path | Node.js `pg` → [`db.js`](../db.js) → Azure built-in PgBouncer (port 6432, transaction mode) → Postgres |
| Test data | Table with 100,000 rows, primary key on `id` |
| Client | Developer laptop over the public internet. **Network round trip ≈ 207 ms per query.** |
| Method | N parallel workers, each sending queries back-to-back for 10 s per level. Pools sized to the concurrency so the app-side pool isn't the limit. |

### Network time vs database time

| Measurement | Time |
|---|---|
| Network round trip from the test laptop (`SELECT 1`) | **207 ms** |
| Server time: lookup by id | **0.10 ms** |
| Server time: aggregate over 100,000 rows | **42 ms** |

The database answers a typical lookup in 0.1 ms. From the laptop, that same query took about 240 ms, **so 99.9% of the latency in the results below is network.** The throughput numbers are therefore a **lower bound** on what the database can do (see [Expected numbers in production](#expected-numbers-in-production)).

## Results

### Reads: replica, lookup by id

| Concurrency | Ops/sec | Errors | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|
| 1 | 4 | 0 | 254 | 301 | 341 |
| 10 | 36 | 0 | 264 | 495 | 753 |
| 50 | 210 | 0 | 238 | 290 | 302 |
| 100 | 374 | 0 | 220 | 308 | 2,184 |
| 200 | **645** | 0 | 244 | 394 | 3,161 |

### Writes: primary, single-row UPDATE

| Concurrency | Ops/sec | Errors | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|
| 1 | 4 | 0 | 261 | 286 | 289 |
| 10 | 35 | 0 | 248 | 310 | 1,890 |
| 50 | 174 | 0 | 219 | 299 | 2,625 |
| 100 | 365 | 0 | 234 | 308 | 2,171 |
| 200 | **661** | 0 | 248 | 383 | 2,967 |

### Mixed: 80% reads / 20% writes (typical app traffic)

| Concurrency | Ops/sec | Errors | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|
| 1 | 4 | 0 | 251 | 288 | 340 |
| 10 | 35 | 0 | 229 | 485 | 1,921 |
| 50 | 175 | 0 | 245 | 320 | 2,072 |
| 100 | 363 | 0 | 241 | 314 | 2,146 |
| 200 | **634** | 0 | 250 | 367 | 2,630 |

### Transactions: transfer (lock 2 rows + 2 UPDATEs + COMMIT, 5 round trips)

| Concurrency | Ops/sec | Errors | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|
| 10 | 8 | 0 | 1,307 | 1,613 | 1,614 |
| 50 | 40 | 0 | 1,261 | 1,327 | 1,463 |
| 100 | **48** | 0 | 1,780 | 3,575 | 4,192 |

### Heavy reads: aggregate over 100,000 rows on the replica

| Concurrency | Ops/sec | Errors | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|
| 1 | 4 | 0 | 260 | 357 | 461 |
| 10 | 34 | 0 | 256 | 301 | 2,043 |
| 50 | **75** | 0 | 575 | 780 | 3,147 |

### Load split between the servers

Transactions committed during the test, from `pg_stat_database`:

| Server | Committed |
|---|---:|
| Primary | 16,724 (writes, transfers, setup) |
| Replica | 24,632 (reads) |

Reads ran on the replica as designed. The replica stayed healthy, with **0 s lag** after the test even under 200 concurrent writers.

## Findings

1. **Parallel requests: yes, and it scales linearly.** Throughput grew in step with concurrency (4 → 645 ops/sec, 160×) while the median latency stayed flat at about 240 ms, the network round trip. The database was **not** the bottleneck for simple reads and writes at any level tested. Throughput was capped by the laptop's network distance, not by Postgres.

2. **Zero errors** across all levels: no connection failures, timeouts, deadlocks or pool exhaustion. PgBouncer handled 400 client connections (200 per server) without problems.

3. **Transactions plateau at about 48/sec from the laptop.** This is PgBouncer, not Postgres. In transaction mode, each transaction holds a real database connection until COMMIT. Here a transaction took 5 round trips (about 1.25 s over the internet), so PgBouncer's server pool (`pgbouncer.default_pool_size`, about 50 connections) ran out at around 40–60 transactions per second. From inside Azure, the same transaction takes about 5 ms, so the same pool supports thousands per second. **Lesson: keep transactions short, and never call external APIs inside one.**

4. **Heavy queries are where the server's CPU is the limit.** The 100,000-row aggregate costs 42 ms of CPU. At 50 parallel it reached about 75/sec with p50 rising to 575 ms. That is the replica's CPU saturating, and it is the one result here that measures the database itself. Heavy reports should run on the replica (as they did here), use indexes or pre-aggregated tables, and if they're frequent, the replica needs more vCores.

5. **p99 spikes of 2–3 s** appear at every concurrency level, even at 10, while p95 stays near the round trip. That pattern points to internet packet loss and TCP retransmits between the laptop and Azure, not to database queuing. It should be confirmed by re-running from inside Azure, where it is expected to disappear.

## Expected numbers in production

These are estimates from the measured server times above, not measurements. Confirm them by running `npm run loadtest` from a VM in the same region and VNet (round trip about 1 ms):

| Workload | From laptop (measured) | Same VNet (estimated) | Limited by |
|---|---:|---:|---|
| Lookup by id | 645/sec | several thousand/sec | Server CPU (2 vCores) |
| Single-row write | 661/sec | a few thousand/sec | CPU and disk IOPS/WAL |
| Short transaction | 48/sec | 1,000+/sec | PgBouncer pool, CPU |
| 100,000-row aggregate | 75/sec | ~50–100/sec | Replica CPU (same either way) |

## Recommendations

1. **Re-run from inside Azure** (`npm run loadtest` on a VM or container in the app's VNet) to get production numbers. While it runs, watch **CPU percent**, **IOPS** and **Max Physical Replication Lag** in Azure Portal → Metrics.
2. **Run the app in the same region and VNet as the database.** Network distance is by far the largest factor in what the app experiences.
3. **Keep transactions to a few fast statements.** Long transactions hold PgBouncer server connections and cap throughput (finding 3).
4. **Send heavy and report queries to `db.read()` (the replica).** If they are frequent, scale the replica's vCores, or pre-aggregate.
5. **Apply the server settings** in [server-config.md](server-config.md): `pg_stat_statements`, autovacuum, `work_mem`, and a General Purpose (not Burstable) tier.
6. **Scale-up signal:** sustained CPU above 70% on either server during real traffic.

## How to re-run

```bash
npm run loadtest                       # 10 s per level, about 4 minutes total
LOADTEST_SECONDS=30 npm run loadtest   # longer runs for steadier numbers
```
The script creates `loadtest_members` (100,000 rows) in the configured database and drops it at the end. Run it against staging, not production.
