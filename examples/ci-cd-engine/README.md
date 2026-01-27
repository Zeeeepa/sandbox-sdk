# CI/CD Engine

A production-ready CI/CD orchestration engine built on Cloudflare Sandbox SDK, providing:

- **Fast job execution** in isolated Docker containers on Cloudflare edge
- **Smart caching** with automatic dependency detection and R2 storage
- **State persistence** via workspace snapshots for resumable builds
- **Distributed queue** with priority scheduling and concurrency control
- **Real-time metrics** and dashboard for monitoring
- **Auto-scaling** via Cloudflare Workers horizontal scaling

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                    │
│                   (CI/CD Orchestrator)                  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │   Job    │  │  State   │  │  Cache   │             │
│  │  Queue   │  │ Manager  │  │ Manager  │             │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘             │
│       │             │             │                     │
│  ┌────▼─────────────▼─────────────▼─────┐             │
│  │         Orchestrator Engine          │             │
│  └────────────────┬──────────────────────┘             │
│                   │                                     │
│  ┌────────────────▼──────────────────────┐             │
│  │     Sandbox Durable Object            │             │
│  │  (Container Lifecycle Management)     │             │
│  └────────────────┬──────────────────────┘             │
└───────────────────┼──────────────────────────────────────┘
                    │
         ┌──────────▼──────────┐
         │  Docker Container    │
         │  (Isolated Runtime)  │
         └──────────────────────┘
```

## Features

### 1. Job Execution

Submit jobs via REST API with multi-step workflows:

```typescript
const job = {
  id: 'build-123',
  repo: 'https://github.com/user/repo',
  commit: 'abc123',
  branch: 'main',
  steps: [
    { name: 'Install', run: 'npm install' },
    { name: 'Test', run: 'npm test' },
    { name: 'Build', run: 'npm run build' }
  ],
  cacheKeys: ['package-lock.json'],
  timeout: 600,
  priority: 5
};

await fetch('https://ci-cd-engine.workers.dev/jobs/submit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(job)
});
```

### 2. Smart Caching

Automatically caches dependencies based on lockfile hashes:

- **Node.js**: `node_modules`, `.npm`, `.yarn/cache`
- **Python**: `.venv`, `__pycache__`, `.pip-cache`
- **Go**: `go/pkg/mod`, `.cache/go-build`
- **Rust**: `target`, `.cargo/registry`

Cache invalidation is automatic when lockfiles change.

### 3. State Persistence

Workspace snapshots enable:

- **Resume builds** from last successful step
- **Artifact preservation** across job runs
- **Debugging** by restoring exact build state

### 4. Distributed Queue

Priority-based job scheduling:

- Concurrent execution (configurable max)
- Priority levels (0-10)
- Automatic retry on failure
- Job cancellation support

### 5. Real-Time Monitoring

```bash
# Stream job logs
curl 'https://ci-cd-engine.workers.dev/jobs/logs?id=build-123'

# View dashboard
open https://ci-cd-engine.workers.dev/dashboard

# Get metrics
curl 'https://ci-cd-engine.workers.dev/metrics?range=day'
```

## Setup

### 1. Prerequisites

- Cloudflare account with Workers enabled
- R2 buckets for state and cache
- KV namespaces for queue and metrics
- (Optional) Analytics Engine for advanced metrics

### 2. Create Resources

```bash
# Create R2 buckets
wrangler r2 bucket create ci-cd-state
wrangler r2 bucket create ci-cd-cache

# Create KV namespaces
wrangler kv:namespace create "CI_QUEUE_KV"
wrangler kv:namespace create "CI_METRICS_KV"

# Create preview namespaces for development
wrangler kv:namespace create "CI_QUEUE_KV" --preview
wrangler kv:namespace create "CI_METRICS_KV" --preview
```

### 3. Update wrangler.toml

Replace placeholder IDs with your actual namespace IDs from step 2.

### 4. Deploy

```bash
# Install dependencies
npm install

# Deploy to Cloudflare
npm run deploy
```

## API Reference

### Submit Job

```
POST /jobs/submit
Content-Type: application/json

{
  "id": "unique-job-id",
  "repo": "https://github.com/user/repo",
  "commit": "commit-hash",
  "branch": "main",
  "steps": [
    {
      "name": "Step name",
      "run": "shell command",
      "workingDir": "/workspace/repo",
      "env": { "KEY": "value" },
      "continueOnError": false,
      "timeout": 300
    }
  ],
  "env": { "GLOBAL_VAR": "value" },
  "cacheKeys": ["package-lock.json", "requirements.txt"],
  "timeout": 600,
  "priority": 5
}
```

### Get Job Status

```
GET /jobs/status?id=job-id
```

Response:
```json
{
  "id": "job-id",
  "status": "running",
  "currentStep": 1,
  "startedAt": 1234567890,
  "steps": [
    {
      "name": "Install",
      "status": "success",
      "output": "...",
      "exitCode": 0,
      "duration": 5000
    }
  ]
}
```

### Stream Logs

```
GET /jobs/logs?id=job-id
```

Returns Server-Sent Events stream with real-time step outputs.

### Cancel Job

```
POST /jobs/cancel
Content-Type: application/json

{ "jobId": "job-id" }
```

### List Jobs

```
GET /jobs?status=running
```

Statuses: `queued`, `running`, `success`, `failure`, `timeout`, `cancelled`

### Cache Statistics

```
GET /cache/stats
```

### Metrics

```
GET /metrics?range=day
```

Ranges: `hour`, `day`, `week`

Response:
```json
{
  "totalJobs": 150,
  "successRate": 94.5,
  "avgDuration": 45000,
  "cacheHitRate": 87.3
}
```

### Dashboard

```
GET /dashboard
```

Returns HTML dashboard with metrics visualization.

## Configuration

### Queue Settings

In `src/job-queue.ts`:

```typescript
{
  maxConcurrent: 10,    // Max parallel jobs
  defaultPriority: 5,   // Default job priority (0-10)
  maxRetries: 3         // Retry attempts on failure
}
```

### Cache Settings

Cache retention: 30 days (configurable in `cache-manager.ts`)

Snapshot retention: 7 days (configurable in `state-manager.ts`)

### Maintenance

Automated maintenance runs hourly via cron:

- Prune old snapshots (>7 days)
- Prune old caches (>30 days)
- Clean up completed jobs (>7 days)

## Performance

### Cold Start

- Container startup: ~2-5 seconds
- Warm container reuse: < 100ms

### Cache Performance

- Cache save: ~1-3 seconds (depends on size)
- Cache restore: ~1-2 seconds
- Cache hit rate: typically 80-90%

### Scalability

- Horizontal: Unlimited (Cloudflare Workers auto-scaling)
- Concurrent jobs: Configurable (default 10 per worker)
- Queue depth: Unlimited
- Storage: Unlimited (R2)

## Monitoring

### Logs

```bash
# Tail live logs
npm run tail

# Filter by job
wrangler tail --format json | grep "job-id"
```

### Metrics

Access dashboard at `/dashboard` for:

- Total jobs processed
- Success rate
- Average duration
- Cache hit rate

### Alerts

Set up alerts via Cloudflare Workers Analytics:

- High failure rate (>10%)
- Long queue depth (>100 jobs)
- Low cache hit rate (<50%)

## Troubleshooting

### Job Stuck in Queue

Check concurrent job limit:
```bash
curl https://ci-cd-engine.workers.dev/jobs?status=running
```

### Cache Miss

Verify lockfile paths in job config:
```typescript
cacheKeys: ['package-lock.json'] // Must be correct path
```

### Job Timeout

Increase timeout in job config or step timeout:
```typescript
{
  timeout: 900, // Job timeout (seconds)
  steps: [
    { name: '...', run: '...', timeout: 300 } // Step timeout
  ]
}
```

### Container Errors

Check sandbox logs:
```bash
curl 'https://ci-cd-engine.workers.dev/jobs/logs?id=job-id'
```

## Examples

### Node.js Build

```typescript
{
  id: 'node-build-123',
  repo: 'https://github.com/user/node-app',
  commit: 'main',
  branch: 'main',
  steps: [
    { name: 'Install', run: 'npm ci' },
    { name: 'Lint', run: 'npm run lint' },
    { name: 'Test', run: 'npm test' },
    { name: 'Build', run: 'npm run build' }
  ],
  cacheKeys: ['package-lock.json'],
  timeout: 600
}
```

### Python Tests

```typescript
{
  id: 'python-test-456',
  repo: 'https://github.com/user/python-app',
  commit: 'main',
  branch: 'main',
  steps: [
    { name: 'Install', run: 'pip install -r requirements.txt' },
    { name: 'Test', run: 'pytest' },
    { name: 'Coverage', run: 'coverage report' }
  ],
  cacheKeys: ['requirements.txt'],
  env: { PYTHONPATH: '/workspace/repo' }
}
```

### Go Build

```typescript
{
  id: 'go-build-789',
  repo: 'https://github.com/user/go-app',
  commit: 'main',
  branch: 'main',
  steps: [
    { name: 'Download', run: 'go mod download' },
    { name: 'Test', run: 'go test ./...' },
    { name: 'Build', run: 'go build -o app' }
  ],
  cacheKeys: ['go.sum'],
  env: { CGO_ENABLED: '0' }
}
```

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for development guidelines.

## License

MIT

