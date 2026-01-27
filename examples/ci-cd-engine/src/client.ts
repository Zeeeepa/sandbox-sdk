/**
 * CI/CD Engine Client SDK
 * 
 * Usage:
 * ```typescript
 * const client = new CICDClient('https://ci-cd-engine.workers.dev');
 * 
 * const jobId = await client.submitJob({
 *   repo: 'https://github.com/user/repo',
 *   commit: 'main',
 *   steps: [...]
 * });
 * 
 * const status = await client.getJobStatus(jobId);
 * ```
 */

import type { JobConfig, JobStatus } from './types';

export class CICDClient {
  constructor(private baseUrl: string) {}

  /**
   * Submit a new job
   */
  async submitJob(job: Omit<JobConfig, 'id'> & { id?: string }): Promise<string> {
    const jobId = job.id || `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const fullJob: JobConfig = { ...job, id: jobId };

    const response = await fetch(`${this.baseUrl}/jobs/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullJob)
    });

    if (!response.ok) {
      throw new Error(`Failed to submit job: ${response.statusText}`);
    }

    const result = await response.json();
    return result.jobId;
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<JobStatus> {
    const response = await fetch(`${this.baseUrl}/jobs/status?id=${jobId}`);

    if (!response.ok) {
      throw new Error(`Failed to get job status: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * List jobs with optional status filter
   */
  async listJobs(status?: JobStatus['status']): Promise<JobStatus[]> {
    const url = status 
      ? `${this.baseUrl}/jobs?status=${status}` 
      : `${this.baseUrl}/jobs`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to list jobs: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/jobs/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId })
    });

    if (!response.ok) {
      throw new Error(`Failed to cancel job: ${response.statusText}`);
    }

    const result = await response.json();
    return result.cancelled;
  }

  /**
   * Stream job logs in real-time
   */
  async *streamLogs(jobId: string): AsyncGenerator<string> {
    const response = await fetch(`${this.baseUrl}/jobs/logs?id=${jobId}`);

    if (!response.ok) {
      throw new Error(`Failed to stream logs: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            yield line;
          }
        }
      }

      if (buffer.trim()) {
        yield buffer;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Wait for job completion
   */
  async waitForCompletion(
    jobId: string, 
    options: {
      pollInterval?: number;
      timeout?: number;
      onProgress?: (status: JobStatus) => void;
    } = {}
  ): Promise<JobStatus> {
    const pollInterval = options.pollInterval || 2000;
    const timeout = options.timeout || 600000; // 10 minutes default
    const startTime = Date.now();

    while (true) {
      const status = await this.getJobStatus(jobId);

      if (options.onProgress) {
        options.onProgress(status);
      }

      if (['success', 'failure', 'timeout', 'cancelled'].includes(status.status)) {
        return status;
      }

      if (Date.now() - startTime > timeout) {
        throw new Error(`Job timeout after ${timeout}ms`);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{
    totalCaches: number;
    totalSize: number;
    caches: Array<{ key: string; paths: string[]; lastUsed: number; size?: number }>;
  }> {
    const response = await fetch(`${this.baseUrl}/cache/stats`);

    if (!response.ok) {
      throw new Error(`Failed to get cache stats: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Get metrics
   */
  async getMetrics(timeRange: 'hour' | 'day' | 'week' = 'day'): Promise<{
    totalJobs: number;
    successRate: number;
    avgDuration: number;
    cacheHitRate: number;
  }> {
    const response = await fetch(`${this.baseUrl}/metrics?range=${timeRange}`);

    if (!response.ok) {
      throw new Error(`Failed to get metrics: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Get dashboard URL
   */
  getDashboardUrl(): string {
    return `${this.baseUrl}/dashboard`;
  }
}

/**
 * Helper to create job config from common patterns
 */
export class JobBuilder {
  private config: Partial<JobConfig> = {
    steps: [],
    env: {},
    cacheKeys: [],
    priority: 5
  };

  repo(url: string): this {
    this.config.repo = url;
    return this;
  }

  commit(hash: string): this {
    this.config.commit = hash;
    return this;
  }

  branch(name: string): this {
    this.config.branch = name;
    return this;
  }

  step(name: string, command: string, options?: {
    workingDir?: string;
    env?: Record<string, string>;
    continueOnError?: boolean;
    timeout?: number;
  }): this {
    this.config.steps!.push({
      name,
      run: command,
      ...options
    });
    return this;
  }

  env(key: string, value: string): this {
    this.config.env![key] = value;
    return this;
  }

  cache(...lockfiles: string[]): this {
    this.config.cacheKeys!.push(...lockfiles);
    return this;
  }

  timeout(seconds: number): this {
    this.config.timeout = seconds;
    return this;
  }

  priority(level: number): this {
    this.config.priority = level;
    return this;
  }

  build(): Omit<JobConfig, 'id'> {
    if (!this.config.repo || !this.config.commit || !this.config.steps || this.config.steps.length === 0) {
      throw new Error('Missing required fields: repo, commit, and at least one step');
    }

    return this.config as Omit<JobConfig, 'id'>;
  }
}

/**
 * Example usage:
 * 
 * ```typescript
 * const client = new CICDClient('https://ci-cd-engine.workers.dev');
 * 
 * const job = new JobBuilder()
 *   .repo('https://github.com/user/repo')
 *   .commit('main')
 *   .branch('main')
 *   .env('CI', 'true')
 *   .step('Install', 'npm ci')
 *   .step('Test', 'npm test')
 *   .step('Build', 'npm run build')
 *   .cache('package-lock.json')
 *   .timeout(600)
 *   .build();
 * 
 * const jobId = await client.submitJob(job);
 * const status = await client.waitForCompletion(jobId, {
 *   onProgress: (status) => console.log(`Step ${status.currentStep}`)
 * });
 * ```
 */

