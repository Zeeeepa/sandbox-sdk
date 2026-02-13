# CI/CD Engine Architecture

Comprehensive technical architecture documentation for the Cloudflare Sandbox-based CI/CD engine.

## Overview

The CI/CD Engine is a production-ready, horizontally scalable job orchestration system built on Cloudflare's edge infrastructure. It provides isolated Docker container execution, intelligent caching, workspace persistence, and distributed job scheduling.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Edge Network                            │
│                  (Cloudflare Workers)                        │
└──────────────────────┬───────────────────────────────────────┘
                       │
         ┌─────────────▼──────────────┐
         │   Orchestrator Worker      │
         │  (Main Entry Point)        │
         └──────────┬─────────────────┘
                    │
      ┌─────────────┼─────────────────┐
      │             │                 │
┌─────▼──────┐ ┌───▼────┐ ┌─────────▼─────┐
│  Job Queue │ │ State  │ │ Cache Manager │
│  (KV + DO) │ │Manager │ │  (R2 + KV)    │
└─────┬──────┘ │  (R2)  │ └─────────┬─────┘
      │        └───┬────┘           │
      └────────────┼────────────────┘
                   │
         ┌─────────▼──────────────┐
         │  Sandbox Durable       │
         │  Object Instance       │
         │  (Container Manager)   │
         └─────────┬──────────────┘
                   │
         ┌─────────▼──────────────┐
         │   Docker Container     │
         │   (Isolated Runtime)   │
         │   - Ubuntu 22.04       │
         │   - Node 20 LTS        │
         │   - Python 3.11        │
         │   - Bun 1.x            │
         └────────────────────────┘
```

## Core Components

### 1. Orchestrator Worker (`src/index.ts`)

**Responsibilities:**
- HTTP request routing
- Job submission and validation
- Status queries and monitoring
- Log streaming
- Dashboard rendering

**Endpoints:**
- `POST /jobs/submit` - Submit new job
- `GET /jobs/status` - Get job status
- `GET /jobs/logs` - Stream job logs
- `POST /jobs/cancel` - Cancel running job
- `GET /jobs` - List jobs
- `GET /cache/stats` - Cache statistics
- `GET /metrics` - Performance metrics
- `GET /dashboard` - Web dashboard

**Scheduled Tasks:**
- Every minute: Process job queue
- Every hour: Run maintenance (prune old data)

### 2. Job Queue (`src/job-queue.ts`)

**Architecture:**
- Priority queue implemented via KV namespace
- Key format: `queue:{priority}:{timestamp}:{jobId}`
- Natural sorting: High priority first, then FIFO

**Features:**
- Priority levels (0-10)
- Concurrent job limiting
- Job status tracking
- Automatic retry support
- Job cancellation

**State Machine:**
```
queued → running → success/failure/timeout/cancelled
```

**Concurrency Control:**
- Max concurrent jobs configurable
- Prevents resource exhaustion
- Fair scheduling across priorities

### 3. State Manager (`src/state-manager.ts`)

**Purpose:** Workspace snapshot and restoration for resumable builds

**Operations:**

1. **Create Snapshot**
   - Tar + gzip workspace directories
   - Upload to R2 with metadata
   - Key format: `snapshots/{jobId}/{commit}/{timestamp}.tar.gz`

2. **Restore Snapshot**
   - Download from R2
   - Extract to sandbox filesystem
   - Maintain directory structure

3. **Prune Old Snapshots**
   - Delete snapshots older than 7 days
   - Scheduled via cron

**Use Cases:**
- Resume failed builds
- Preserve artifacts across runs
- Debug exact build state

### 4. Cache Manager (`src/cache-manager.ts`)

**Purpose:** Smart dependency caching with automatic invalidation

**Cache Key Generation:**
```
{repo}-{commit}-{hash(lockfile1+lockfile2+...)}
```

**Automatic Detection:**
- Node.js: `package-lock.json` → caches `node_modules`, `.npm`
- Python: `requirements.txt` → caches `.venv`, `__pycache__`
- Go: `go.sum` → caches `go/pkg/mod`, `.cache/go-build`
- Rust: `Cargo.lock` → caches `target`, `.cargo/registry`

**Cache Lifecycle:**
1. Generate cache key from lockfiles
2. Check R2 for existing cache
3. Restore if found (cache hit)
4. Execute build
5. Save new cache if successful

**Storage:**
- R2 for tar.gz archives
- KV for metadata (quick lookups)
- TTL: 30 days

**Performance:**
- Save: 1-3 seconds (depends on size)
- Restore: 1-2 seconds
- Typical hit rate: 80-90%

### 5. Orchestrator Engine (`src/orchestrator.ts`)

**Workflow:**

```
1. Setup Workspace
   ├─ Clone repository
   ├─ Checkout commit/branch
   └─ Set environment variables

2. Restore Cache (if available)
   ├─ Generate cache key
   ├─ Check R2 for cache
   └─ Restore to sandbox

3. Execute Steps Sequentially
   ├─ For each step:
   │  ├─ Set step env vars
   │  ├─ Execute command in sandbox
   │  ├─ Capture output & exit code
   │  └─ Update status
   └─ Stop on first failure (unless continueOnError)

4. Save Cache (on success)
   ├─ Generate cache key
   ├─ Tar cache directories
   └─ Upload to R2

5. Create Snapshot (on success)
   ├─ Archive workspace
   └─ Upload to R2

6. Update Final Status
   └─ Record metrics
```

**Error Handling:**
- Step timeout enforcement
- Graceful failure propagation
- Detailed error messages
- Automatic cleanup

### 6. Metrics Collector (`src/metrics.ts`)

**Data Points:**
- Job ID and status
- Duration (total and per-step)
- Step count
- Cache hit/miss
- Resource usage (optional)

**Storage:**
- Analytics Engine for aggregation
- KV for quick queries
- Retention: 30 days

**Aggregations:**
- Total jobs
- Success rate (%)
- Average duration (ms)
- Cache hit rate (%)

**Dashboard:**
- Real-time metrics visualization
- Time range filters (hour/day/week)
- Responsive HTML/CSS

## Data Flow

### Job Submission Flow

```
1. Client submits job → POST /jobs/submit
2. Validate job config
3. Store full config in KV (job:{id})
4. Enqueue in priority queue (queue:{priority}:...)
5. Initialize job status (status:{id})
6. Return job ID to client
```

### Job Execution Flow

```
1. Cron trigger → dequeue job
2. Check concurrent limit
3. Get highest priority job from queue
4. Update status to 'running'
5. Acquire Sandbox Durable Object
6. Execute orchestrator workflow
7. Update status throughout execution
8. Save cache and snapshot on success
9. Record metrics
10. Mark job as complete
```

### Log Streaming Flow

```
1. Client connects → GET /jobs/logs?id={id}
2. Create SSE stream
3. Poll job status every 1s
4. Stream new step outputs
5. Close stream on job completion
```

## Scalability

### Horizontal Scaling

**Cloudflare Workers:**
- Auto-scales to millions of requests
- Global edge deployment (300+ cities)
- No configuration required

**Durable Objects:**
- One instance per sandbox
- Strong consistency within instance
- Location affinity for performance

### Concurrency Control

**Queue Settings:**
```typescript
{
  maxConcurrent: 10,  // Per worker instance
  defaultPriority: 5,
  maxRetries: 3
}
```

**Scaling Strategy:**
- Workers scale horizontally (unlimited)
- Each worker processes up to `maxConcurrent` jobs
- Total throughput = workers × maxConcurrent

### Resource Limits

**Cloudflare Workers:**
- CPU: 30,000 ms per request
- Memory: 128 MB per request
- Execution time: No hard limit for Durable Objects

**Docker Containers:**
- Managed by Cloudflare infrastructure
- Auto-terminated after job completion
- Resource quotas enforced at platform level

## Storage Architecture

### R2 (Object Storage)

**State Bucket:**
```
snapshots/
  {jobId}/
    {commit}/
      {timestamp}.tar.gz
```

**Cache Bucket:**
```
cache/
  {cacheKey}.tar.gz
```

**Benefits:**
- Unlimited storage
- Low latency from edge
- S3-compatible API
- No egress fees

### KV (Key-Value Store)

**Queue Keys:**
```
queue:{priority}:{timestamp}:{jobId} → JobConfig
```

**Status Keys:**
```
status:{jobId} → JobStatus
```

**Job Config Keys:**
```
job:{jobId} → JobConfig (for retries)
```

**Cache Metadata Keys:**
```
cache:{cacheKey} → CacheKey metadata
```

**Metrics Keys:**
```
metrics:{jobId} → MetricsData
```

**Performance:**
- Read latency: < 10ms globally
- Write latency: < 50ms
- Eventual consistency

## Security

### Container Isolation

**Docker:**
- Process isolation via namespaces
- Filesystem isolation
- Network isolation
- Resource limits enforced

**Cloudflare Infrastructure:**
- VM-level isolation
- Sandboxed execution
- No shared state between containers

### Access Control

**API Authentication:**
- No built-in auth (add via middleware)
- Recommendation: Cloudflare Access or API tokens

**Repository Access:**
- Public repos: No credentials needed
- Private repos: Configure via env vars or secrets

### Data Security

**R2:**
- Encrypted at rest
- Private by default
- Access via Workers only

**KV:**
- Encrypted at rest
- Scoped to Workers account

## Performance Characteristics

### Latency

**Cold Start:**
- Worker cold start: < 50ms
- Container cold start: 2-5 seconds
- Total cold start: ~2-5 seconds

**Warm Path:**
- Worker execution: < 10ms
- Container reuse: < 100ms

**Cache Operations:**
- Cache lookup: 10-50ms
- Cache restore: 1-2 seconds
- Cache save: 1-3 seconds

### Throughput

**Job Processing:**
- Jobs per worker: 10 concurrent (configurable)
- Worker instances: Auto-scaled
- Total capacity: Effectively unlimited

**API Requests:**
- Cloudflare Workers: Millions per second
- No throttling at platform level

### Storage

**R2:**
- Snapshots: Varies (typically 10-500 MB)
- Caches: Varies (typically 50-500 MB for node_modules)
- Retention: Configurable (default 7-30 days)

**KV:**
- Status objects: ~1-10 KB each
- Retention: 7 days for completed jobs

## Monitoring and Observability

### Logs

**Structured Logging:**
- Job lifecycle events
- Step execution details
- Error messages and stack traces
- Performance metrics

**Access:**
```bash
wrangler tail --format json
```

### Metrics

**Built-in Metrics:**
- Request count
- Error rate
- Execution duration
- Cache hit rate

**Custom Metrics:**
- Job success rate
- Average step duration
- Queue depth
- Cache efficiency

### Dashboard

**Real-Time Metrics:**
- Total jobs (hour/day/week)
- Success rate percentage
- Average duration (seconds)
- Cache hit rate percentage

**URL:** `https://ci-cd-engine.workers.dev/dashboard`

## Maintenance

### Automated Cleanup

**Hourly Cron:**
- Prune snapshots > 7 days old
- Prune caches > 30 days old
- Clean completed jobs > 7 days old

**Benefits:**
- Automatic cost management
- No manual intervention
- Configurable retention

### Manual Maintenance

**Force Cleanup:**
```typescript
// Call maintenance endpoint
POST /admin/maintenance
```

**Cache Management:**
```typescript
// List all caches
GET /cache/stats

// Delete specific cache
DELETE /cache/{cacheKey}
```

## Future Enhancements

### Planned Features

1. **Matrix Builds**
   - Run same job with different parameters
   - Node versions, OS variations, etc.

2. **Artifact Storage**
   - Upload build artifacts to R2
   - Download via signed URLs

3. **Webhook Integration**
   - GitHub/GitLab webhook receivers
   - Automatic build triggers

4. **Notifications**
   - Slack/Discord/Email notifications
   - Configurable triggers

5. **Advanced Caching**
   - Layer caching (Docker-style)
   - Partial cache invalidation

6. **Job Dependencies**
   - Sequential job chaining
   - Parallel job execution with dependencies

7. **Resource Quotas**
   - Per-user limits
   - Cost tracking
   - Usage reports

## Comparison with Traditional CI/CD

| Feature | CI/CD Engine | GitHub Actions | CircleCI | Jenkins |
|---------|-------------|----------------|----------|---------|
| **Deployment** | Edge (300+ cities) | Cloud | Cloud | Self-hosted |
| **Cold Start** | 2-5s | 20-60s | 10-30s | N/A |
| **Scaling** | Auto | Auto | Auto | Manual |
| **Cost Model** | Pay-per-use | Minutes-based | Credits | Infrastructure |
| **Cache Speed** | 1-2s | 10-30s | 5-15s | Varies |
| **Setup Time** | 5 minutes | Minimal | Minimal | Hours |
| **Maintenance** | Zero | Minimal | Minimal | High |

## Best Practices

### Job Configuration

1. **Use specific commits**, not branches
2. **Set reasonable timeouts** (default 5min per step)
3. **Enable caching** for dependency-heavy builds
4. **Use continueOnError** for non-critical steps
5. **Set priorities** for important jobs

### Performance Optimization

1. **Minimize cache size** (exclude unnecessary files)
2. **Use shallow git clones** when possible
3. **Parallelize independent steps** (future feature)
4. **Reuse warm containers** via keep-alive

### Cost Optimization

1. **Enable caching** to reduce build time
2. **Prune old data** regularly
3. **Use efficient Docker images**
4. **Set appropriate timeouts** to prevent runaway jobs

## Troubleshooting Guide

See [README.md](./README.md) for detailed troubleshooting steps.

## References

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare KV](https://developers.cloudflare.com/kv/)
- [Sandbox SDK Documentation](../../packages/sandbox/README.md)

