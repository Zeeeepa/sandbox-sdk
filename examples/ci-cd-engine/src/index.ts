/**
 * CI/CD Engine - Main Worker Entry Point
 */

import { getSandbox, Sandbox } from '@cloudflare/sandbox';
import { StateManager } from './state-manager';
import { CacheManager } from './cache-manager';
import { JobQueue } from './job-queue';
import { Orchestrator } from './orchestrator';
import { MetricsCollector } from './metrics';
import type { JobConfig } from './types';

export interface Env {
  SANDBOX: DurableObjectNamespace<Sandbox>;
  CI_STATE_BUCKET: R2Bucket;
  CI_CACHE_BUCKET: R2Bucket;
  CI_QUEUE_KV: KVNamespace;
  CI_METRICS_KV: KVNamespace;
  CI_ANALYTICS?: AnalyticsEngineDataset;
}

export default {
  /**
   * Main request handler
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Route handlers
      switch (url.pathname) {
        case '/':
          return new Response('CI/CD Engine API - Ready', { status: 200 });

        case '/jobs':
          return handleJobsEndpoint(request, env);

        case '/jobs/submit':
          return handleSubmitJob(request, env);

        case '/jobs/status':
          return handleJobStatus(request, env);

        case '/jobs/cancel':
          return handleCancelJob(request, env);

        case '/jobs/logs':
          return handleJobLogs(request, env);

        case '/cache/stats':
          return handleCacheStats(request, env);

        case '/metrics':
          return handleMetrics(request, env);

        case '/dashboard':
          return handleDashboard(request, env);

        case '/worker':
          return handleWorker(request, env);

        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('Request handler error:', error);
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },

  /**
   * Scheduled handler - Process job queue and maintenance
   */
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const queue = new JobQueue(
      env.CI_QUEUE_KV,
      env.SANDBOX,
      { maxConcurrent: 10, defaultPriority: 5, maxRetries: 3 }
    );

    // Process next job in queue
    const job = await queue.dequeue();
    if (job) {
      await processJob(job, env);
    }

    // Maintenance tasks (run hourly)
    if (event.cron === '0 * * * *') {
      await runMaintenance(env);
    }
  }
};

/**
 * List all jobs or filter by status
 */
async function handleJobsEndpoint(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status') as any;

  const queue = new JobQueue(env.CI_QUEUE_KV, env.SANDBOX);
  const jobs = await queue.listJobs(status);

  return new Response(JSON.stringify(jobs), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Submit a new job
 */
async function handleSubmitJob(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const job: JobConfig = await request.json();

  // Validate job config
  if (!job.id || !job.repo || !job.commit || !job.steps) {
    return new Response('Invalid job configuration', { status: 400 });
  }

  const queue = new JobQueue(env.CI_QUEUE_KV, env.SANDBOX);
  await queue.storeJobConfig(job);
  await queue.enqueue(job);

  return new Response(JSON.stringify({ message: 'Job queued', jobId: job.id }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Get job status
 */
async function handleJobStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get('id');

  if (!jobId) {
    return new Response('Missing job ID', { status: 400 });
  }

  const queue = new JobQueue(env.CI_QUEUE_KV, env.SANDBOX);
  const status = await queue.getJobStatus(jobId);

  if (!status) {
    return new Response('Job not found', { status: 404 });
  }

  return new Response(JSON.stringify(status), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Cancel a job
 */
async function handleCancelJob(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { jobId } = await request.json();

  if (!jobId) {
    return new Response('Missing job ID', { status: 400 });
  }

  const queue = new JobQueue(env.CI_QUEUE_KV, env.SANDBOX);
  const cancelled = await queue.cancelJob(jobId);

  return new Response(JSON.stringify({ cancelled }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Stream job logs
 */
async function handleJobLogs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get('id');

  if (!jobId) {
    return new Response('Missing job ID', { status: 400 });
  }

  const sandbox = getSandbox(env.SANDBOX, `job-${jobId}`);
  const stateManager = new StateManager(env.CI_STATE_BUCKET);
  const cacheManager = new CacheManager(env.CI_CACHE_BUCKET, env.CI_METRICS_KV);
  const queue = new JobQueue(env.CI_QUEUE_KV, env.SANDBOX);

  const orchestrator = new Orchestrator({
    sandbox,
    stateManager,
    cacheManager,
    queue
  });

  const stream = await orchestrator.streamJobLogs(jobId);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

/**
 * Get cache statistics
 */
async function handleCacheStats(request: Request, env: Env): Promise<Response> {
  const cacheManager = new CacheManager(env.CI_CACHE_BUCKET, env.CI_METRICS_KV);
  const caches = await cacheManager.listCaches();

  const stats = {
    totalCaches: caches.length,
    totalSize: caches.reduce((sum, c) => sum + (c.size || 0), 0),
    caches: caches.slice(0, 20) // Return first 20
  };

  return new Response(JSON.stringify(stats), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Get metrics
 */
async function handleMetrics(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const timeRange = (url.searchParams.get('range') || 'day') as 'hour' | 'day' | 'week';

  const metrics = new MetricsCollector(env.CI_ANALYTICS, env.CI_METRICS_KV);
  const aggregate = await metrics.getAggregateMetrics(timeRange);

  return new Response(JSON.stringify(aggregate), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Dashboard HTML
 */
async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const metrics = new MetricsCollector(env.CI_ANALYTICS, env.CI_METRICS_KV);
  const aggregate = await metrics.getAggregateMetrics('day');
  const html = metrics.generateDashboardHTML(aggregate);

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

/**
 * Background worker - processes jobs from queue
 */
async function handleWorker(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const queue = new JobQueue(env.CI_QUEUE_KV, env.SANDBOX);
  const job = await queue.dequeue();

  if (!job) {
    return new Response(JSON.stringify({ message: 'No jobs in queue' }), {
      headers: { 'Content-Type': 'application/json' }
   });
  }

  // Process job asynchronously
  processJob(job, env);

  return new Response(JSON.stringify({ message: 'Job processing started', jobId: job.id }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Process a job
 */
async function processJob(job: JobConfig, env: Env): Promise<void> {
  const sandboxId = `job-${job.id}`;
  const sandbox = getSandbox(env.SANDBOX, sandboxId);
  
  const stateManager = new StateManager(env.CI_STATE_BUCKET);
  const cacheManager = new CacheManager(env.CI_CACHE_BUCKET, env.CI_METRICS_KV);
  const queue = new JobQueue(env.CI_QUEUE_KV, env.SANDBOX);
  const metricsCollector = new MetricsCollector(env.CI_ANALYTICS, env.CI_METRICS_KV);

  const orchestrator = new Orchestrator({
    sandbox,
    stateManager,
    cacheManager,
    queue
  });

  try {
    const status = await orchestrator.executeJob(job);
    
    // Record metrics
    const cacheHit = status.steps.some(s => s.output?.includes('Cache restored'));
    await metricsCollector.recordJobMetrics(status, cacheHit);
    
  } catch (error) {
    console.error('Job processing error:', error);
  }
}

/**
 * Maintenance tasks
 */
async function runMaintenance(env: Env): Promise<void> {
  const stateManager = new StateManager(env.CI_STATE_BUCKET);
  const cacheManager = new CacheManager(env.CI_CACHE_BUCKET, env.CI_METRICS_KV);
  const queue = new JobQueue(env.CI_QUEUE_KV, env.SANDBOX);

  // Prune old snapshots (>7 days)
  await stateManager.pruneSnapshots();

  // Prune old caches (>30 days)
  await cacheManager.pruneCaches();

  // Clean up completed jobs (>7 days)
  await queue.pruneCompletedJobs();

  console.log('Maintenance completed');
}

export { Sandbox } from '@cloudflare/sandbox';

