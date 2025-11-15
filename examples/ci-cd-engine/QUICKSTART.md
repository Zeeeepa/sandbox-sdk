# CI/CD Engine - Quick Start Guide

Get your CI/CD engine running in under 5 minutes.

## Prerequisites

- Node.js 20+ and npm
- Cloudflare account ([sign up free](https://dash.cloudflare.com/sign-up))
- Wrangler CLI (`npm install -g wrangler`)

## Step 1: Clone and Install

```bash
# From sandbox-sdk root
cd examples/ci-cd-engine
npm install
```

## Step 2: Cloudflare Setup

### Authenticate
```bash
wrangler login
```

### Create Resources
```bash
# R2 Buckets
wrangler r2 bucket create ci-cd-state
wrangler r2 bucket create ci-cd-cache

# KV Namespaces
wrangler kv:namespace create "CI_QUEUE_KV"
wrangler kv:namespace create "CI_METRICS_KV"

# Preview namespaces (for local dev)
wrangler kv:namespace create "CI_QUEUE_KV" --preview
wrangler kv:namespace create "CI_METRICS_KV" --preview
```

### Update Configuration

Copy the namespace IDs from the output above and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CI_QUEUE_KV"
id = "YOUR_QUEUE_KV_ID"  # ← Replace
preview_id = "YOUR_QUEUE_KV_PREVIEW_ID"  # ← Replace

[[kv_namespaces]]
binding = "CI_METRICS_KV"
id = "YOUR_METRICS_KV_ID"  # ← Replace
preview_id = "YOUR_METRICS_KV_PREVIEW_ID"  # ← Replace
```

## Step 3: Deploy

```bash
npm run deploy
```

Output will show your Worker URL:
```
Published ci-cd-engine (X.XX sec)
  https://ci-cd-engine.your-subdomain.workers.dev
```

## Step 4: Submit Your First Job

### Using curl

```bash
curl -X POST https://ci-cd-engine.your-subdomain.workers.dev/jobs/submit \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "test-job-1",
    "repo": "https://github.com/nodejs/node",
    "commit": "main",
    "branch": "main",
    "steps": [
      {
        "name": "Check Node Version",
        "run": "node --version"
      },
      {
        "name": "List Files",
        "run": "ls -la",
        "workingDir": "/workspace/repo"
      }
    ],
    "timeout": 300
  }'
```

### Using the Client SDK

```typescript
import { CICDClient, JobBuilder } from './src/client';

const client = new CICDClient('https://ci-cd-engine.your-subdomain.workers.dev');

const job = new JobBuilder()
  .repo('https://github.com/nodejs/node')
  .commit('main')
  .branch('main')
  .step('Check Node', 'node --version')
  .step('List Files', 'ls -la', { workingDir: '/workspace/repo' })
  .timeout(300)
  .build();

const jobId = await client.submitJob(job);
console.log(`Job submitted: ${jobId}`);

// Wait for completion
const status = await client.waitForCompletion(jobId, {
  onProgress: (status) => {
    console.log(`Current step: ${status.currentStep + 1}/${status.steps.length}`);
  }
});

console.log(`Job ${status.status}`);
```

## Step 5: Monitor Your Job

### Check Status

```bash
curl 'https://ci-cd-engine.your-subdomain.workers.dev/jobs/status?id=test-job-1'
```

### Stream Logs

```bash
curl 'https://ci-cd-engine.your-subdomain.workers.dev/jobs/logs?id=test-job-1'
```

### View Dashboard

Open in browser:
```
https://ci-cd-engine.your-subdomain.workers.dev/dashboard
```

## Common Use Cases

### Node.js Build

```bash
curl -X POST https://ci-cd-engine.your-subdomain.workers.dev/jobs/submit \
  -H 'Content-Type: application/json' \
  -d @examples/node-build.json
```

### Python Tests

```bash
curl -X POST https://ci-cd-engine.your-subdomain.workers.dev/jobs/submit \
  -H 'Content-Type: application/json' \
  -d @examples/python-test.json
```

### Custom Workflow

```typescript
const job = new JobBuilder()
  .repo('https://github.com/user/repo')
  .commit('abc123')
  .branch('feature/new-feature')
  .env('CI', 'true')
  .env('NODE_ENV', 'test')
  
  // Install phase
  .step('Install Dependencies', 'npm ci', { timeout: 300 })
  
  // Quality checks
  .step('Lint', 'npm run lint', { continueOnError: true })
  .step('Type Check', 'npm run typecheck')
  
  // Testing
  .step('Unit Tests', 'npm run test:unit')
  .step('Integration Tests', 'npm run test:integration')
  
  // Build
  .step('Build Production', 'npm run build', {
    env: { NODE_ENV: 'production' }
  })
  
  // Cache configuration
  .cache('package-lock.json')
  
  .timeout(900)
  .priority(7)
  .build();

await client.submitJob(job);
```

## Local Development

```bash
# Start local dev server
npm run dev

# Submit job to local instance
curl -X POST http://localhost:8787/jobs/submit \
  -H 'Content-Type: application/json' \
  -d '{ ... }'
```

## Next Steps

- **Configure Webhooks**: Integrate with GitHub/GitLab webhooks for automatic builds
- **Set Up Notifications**: Add Slack/Discord notifications for job completion
- **Advanced Caching**: Configure cache paths for your specific tech stack
- **Custom Metrics**: Add Analytics Engine for detailed performance tracking
- **Parallel Jobs**: Increase `maxConcurrent` in queue config for higher throughput

## Troubleshooting

### "Namespace not found"

Update namespace IDs in `wrangler.toml` with values from `wrangler kv:namespace create`.

### "Permission denied"

Ensure you're authenticated: `wrangler login`

### Jobs not processing

Check cron triggers are enabled:
```bash
wrangler tail --format json | grep "scheduled"
```

### Cache not working

Verify R2 bucket names in `wrangler.toml` match created buckets.

## Support

- **Documentation**: See [README.md](./README.md) for full API reference
- **Issues**: [GitHub Issues](https://github.com/Zeeeepa/sandbox-sdk/issues)
- **Examples**: Check `examples/` directory for more use cases

## Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare R2 Docs](https://developers.cloudflare.com/r2/)
- [Sandbox SDK Docs](../../packages/sandbox/README.md)

