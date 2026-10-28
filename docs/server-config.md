# Postgres server configuration for heavy load

**Servers:** `your-primary` (primary) and `your-replica` (read replica). Azure Database for PostgreSQL Flexible Server, PostgreSQL 18.6.

**Current size:** 8 GiB RAM. `shared_buffers` is 2 GB (25% of RAM) and `max_connections` is 859, which is Azure's value for 2 vCores / 8 GiB.

Apply these in **Azure Portal → server → Settings → Server parameters**. The primary and the replica each have their own parameters. After **Save**, the Portal tells you if a parameter needs a restart.

> No configuration is perfect in advance. These values are a sound starting point for an OLTP workload (many short reads and writes, like points or balances) at this server size. Once real traffic runs, use `pg_stat_statements` and Query Store (section 4) to find the slow queries. Indexes and query fixes usually gain far more than tuning parameters.

## 1. Infrastructure: the biggest levers

| What | Recommendation | Why |
|---|---|---|
| Compute tier | **General Purpose (D-series)**, not Burstable (B-series). Check under *Compute + storage*. | Burstable servers run on CPU credits. Under sustained load the credits run out and CPU is throttled to a fraction. |
| vCores | Start at 2, and scale up (to 4 or more) when CPU stays above 70%. Choose **Memory Optimized (E-series)** if the hot data outgrows RAM. | Scaling up is a short restart, and the primary and replica can be resized separately. |
| Replica size | **Same as the primary or larger.** | A smaller replica can't keep up with replaying the primary's writes, so its lag grows. |
| Storage | Premium SSD v2 if available in your region, or a larger Premium SSD disk. Enable **storage autogrow**. | On Premium SSD (v1), IOPS grow with disk size. Premium SSD v2 lets you set IOPS and throughput separately. |
| High availability | Enable **zone-redundant HA** on the primary for production. | A read replica is **not** a failover target. HA keeps a hot standby and fails over automatically. |
| Network | Run the app in the **same region and VNet** (private access). | Each query from a laptop takes about 300 ms; from the same VNet, about 1 ms. Latency limits throughput far more than any parameter. |
| More read capacity | Add replicas (up to 5), or use virtual endpoints. | Each replica adds read capacity. |

## 2. PgBouncer (both servers)

| Parameter | Current | Set to | Why |
|---|---|---|---|
| `pgbouncer.enabled` | off | **true** | Lets many app connections share a few real database connections. Connect on port **6432**. |
| `pgbouncer.pool_mode` | transaction | **transaction** (keep) | Gives the best reuse of connections. See the limitations in the README. |
| `pgbouncer.default_pool_size` | 50 | **20** (about 10 × vCores) | Real server connections per user and database. 2 vCores can't run 50 queries in parallel, so extra connections only compete for CPU. |
| `pgbouncer.max_client_conn` | 5000 | 5000 (keep) | App connections are cheap for PgBouncer. |

Then set `POSTGRES_PGBOUNCER=true` in the app's `.env`. With PgBouncer, `POSTGRES_POOL_MAX` in each app copy can go up to 20–30.

## 3. Primary: memory, disk, WAL and autovacuum

| Parameter | Current | Set to | Why |
|---|---|---|---|
| `shared_buffers` | 2 GB | keep | Azure already sets 25% of RAM, which is correct. |
| `effective_cache_size` | 6 GB | keep | Azure already sets 75% of RAM. |
| `work_mem` | 4 MB | **16 MB** (`16384`) | Memory for each sort or hash in a query. At 4 MB, sorts spill to disk. Roughly (RAM − shared_buffers) / (active connections × 3) ≈ 6 GB / 60. Give report users more per role: `ALTER ROLE reporting SET work_mem = '64MB'`. |
| `maintenance_work_mem` | 211 MB | **512 MB** (`524288`) | Speeds up VACUUM and index builds. |
| `random_page_cost` | 2 | **1.1** | SSD storage, so random reads cost almost the same as sequential reads. The planner then picks indexes more readily. |
| `effective_io_concurrency` | 16 | **200** | SSDs handle many disk reads in parallel. |
| `max_wal_size` | 2 GB | **8 GB** (`8192`) | Fewer forced checkpoints during write bursts. Keep disk space for it. |
| `min_wal_size` | 80 MB | **1 GB** (`1024`) | Reuses WAL files instead of creating new ones. |
| `checkpoint_timeout` | 10 min | keep | |
| `checkpoint_completion_target` | 0.9 | keep | Spreads checkpoint writes over time. |
| `autovacuum_vacuum_scale_factor` | 0.2 | **0.05** | Vacuums after 5% of a table changes instead of 20%. Busy tables stay small and fast. |
| `autovacuum_analyze_scale_factor` | 0.1 | **0.02** | Keeps the planner's statistics current. |
| `autovacuum_vacuum_cost_limit` | −1 (=200) | **2000** | Lets autovacuum work about 10× faster, so it keeps up with heavy writes. |
| `autovacuum_naptime` | 60 s | **30 s** | Checks for work more often. |
| `autovacuum_max_workers` | 3 | keep (raise to 4–6 at 4+ vCores) | |
| `synchronous_commit` | on | **on (keep)** | Turning it off is faster, but the last few milliseconds of committed transactions can be lost in a crash. That isn't acceptable for points and balances. |
| `jit` | off | **off (keep)** | JIT slows down short OLTP queries. |
| `max_parallel_workers_per_gather` | 2 | keep | Right for 2 vCores. |

## 4. Primary: query statistics and logging (needed to find slow queries)

| Parameter | Current | Set to | Why |
|---|---|---|---|
| `pg_stat_statements.track` | none | **top** | Records time and call counts for every query. Then run `CREATE EXTENSION pg_stat_statements;` (first add it to `azure.extensions`). |
| `pg_qs.query_capture_mode` | (check) | **top** | Azure Query Store: query history in the Portal under *Intelligent Performance*. |
| `track_io_timing` | off | **on** | Shows how much of each query's time is spent waiting on disk. |
| `log_min_duration_statement` | −1 | **1000** (ms) | Logs every query slower than 1 s. |
| `log_lock_waits` | off | **on** | Logs queries that wait on locks longer than `deadlock_timeout`. |
| `log_autovacuum_min_duration` | (check) | **10000** (ms) | Shows autovacuum runs that are slow. |

Timeouts (`statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout`) are set **per app user** in [`sql/setup.sql`](../sql/setup.sql), not server-wide, so admin and maintenance sessions aren't affected.

Find the slowest queries after a day of traffic:
```sql
SELECT round(total_exec_time) AS total_ms, calls, round(mean_exec_time, 1) AS mean_ms, query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;
```

## 5. Replica

Apply sections 2 and 3 (memory and disk settings) and section 4 to the replica too. Then set these:

| Parameter | Current | Set to | Why |
|---|---|---|---|
| `hot_standby_feedback` | off | **on** | Without it, long reads on the replica get cancelled with *"canceling statement due to conflict with recovery"*. Trade-off: very long replica queries hold back VACUUM on the primary, which causes bloat. The per-role `statement_timeout` limits that. |
| `max_standby_streaming_delay` | 30 s | keep | Only matters if `hot_standby_feedback` stays off. |
| `work_mem` | 4 MB | **32 MB** | Reports and aggregations run here. |

## 6. What to watch (Azure Portal → Metrics, set alerts)

| Metric | Alert when | Action |
|---|---|---|
| CPU percent | > 80% for 15 min | Find the top queries in `pg_stat_statements`, add indexes, then scale up vCores. |
| Memory percent | > 90% | Lower `work_mem`, or scale up. |
| Max Physical Replication Lag (replica) | > 5 s | Make the replica as large as the primary, and look for long writes on the primary. |
| Active connections | Near `max_connections` | Enable PgBouncer, and lower `POSTGRES_POOL_MAX` per app copy. |
| Storage percent | > 80% | Autogrow should handle it. Check for table bloat (autovacuum). |
| Read/Write IOPS | At the disk's limit | Larger disk or Premium SSD v2. Look for queries reading whole tables. |
