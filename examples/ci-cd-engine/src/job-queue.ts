/**
 * Job Queue - Distributed job scheduling with priority and concurrency control
 */

import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import type { JobConfig, JobStatus } from './types';

export interface QueueConfig {
  maxConcurrent: number;
  defaultPriority: number;
  maxRetries: number;
}

export class JobQueue {
  constructor(
    private kv: KVNamespace,
    private namespace: DurableObjectNamespace,
    private config: QueueConfig = {
      maxConcurrent: 10,
      defaultPriority: 5,
      maxRetries: 3
    }
  ) {}

  /**
   * Enqueue a new job
   */
  async enqueue(job: JobConfig): Promise<void> {
    const priority = job.priority ?? this.config.defaultPriority;
    const queueKey = `queue:${priority}:${Date.now()}:${job.id}`;
    
    await this.kv.put(queueKey, JSON.stringify(job), {
      expirationTtl: 24 * 60 * 60 // 24 hours
    });

    // Initialize job status
    const status: JobStatus = {
      id: job.id,
      status: 'queued',
      steps: job.steps.map(step => ({
        name: step.name,
        status: 'pending'
      }))
    };
    await this.updateJobStatus(job.id, status);
  }

  /**
   * Dequeue next job (highest priority first)
   */
  async dequeue(): Promise<JobConfig | null> {
    // Check if we're at max concurrent jobs
    const running = await this.getRunningJobCount();
    if (running >= this.config.maxConcurrent) {
      return null;
    }

    // List all queued jobs, sorted by priority (descending) then timestamp
    const list = await this.kv.list({ prefix: 'queue:' });
    
    if (list.keys.length === 0) {
      return null;
    }

    // Keys are formatted as queue:priority:timestamp:jobId
    // Sort by priority (desc), then timestamp (asc)
    const sortedKeys = list.keys.sort((a, b) => {
      const [, priorityA, timestampA] = a.name.split(':');
      const [, priorityB, timestampB] = b.name.split(':');
      
      const priDiff = parseInt(priorityB) - parseInt(priorityA);
      if (priDiff !== 0) return priDiff;
      
      return parseInt(timestampA) - parseInt(timestampB);
    });

    // Get first job
    const firstKey = sortedKeys[0].name;
    const jobData = await this.kv.get(firstKey, 'json') as JobConfig | null;
    
    if (!jobData) {
      return null;
    }

    // Remove from queue
    await this.kv.delete(firstKey);

    // Mark as running
    const status = await this.getJobStatus(jobData.id);
    if (status) {
      status.status = 'running';
      status.startedAt = Date.now();
      await this.updateJobStatus(jobData.id, status);
    }

    return jobData;
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<JobStatus | null> {
    const data = await this.kv.get(`status:${jobId}`, 'json');
    return data as JobStatus | null;
  }

  /**
   * Update job status
   */
  async updateJobStatus(jobId: string, status: JobStatus): Promise<void> {
    await this.kv.put(`status:${jobId}`, JSON.stringify(status), {
      expirationTtl: 7 * 24 * 60 * 60 // 7 days
    });
  }

  /**
   * Get count of running jobs
   */
  async getRunningJobCount(): Promise<number> {
    const list = await this.kv.list({ prefix: 'status:' });
    let count = 0;

    for (const key of list.keys) {
      const status = await this.kv.get(key.name, 'json') as JobStatus | null;
      if (status?.status === 'running') {
        count++;
      }
    }

    return count;
  }

  /**
   * List all jobs with optional status filter
   */
  async listJobs(statusFilter?: JobStatus['status']): Promise<JobStatus[]> {
    const list = await this.kv.list({ prefix: 'status:' });
    const jobs: JobStatus[] = [];

    for (const key of list.keys) {
      const status = await this.kv.get(key.name, 'json') as JobStatus | null;
      if (status && (!statusFilter || status.status === statusFilter)) {
        jobs.push(status);
      }
    }

    return jobs;
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const status = await this.getJobStatus(jobId);
    if (!status) {
      return false;
    }

    // Remove from queue if queued
    if (status.status === 'queued') {
      const list = await this.kv.list({ prefix: 'queue:' });
      for (const key of list.keys) {
        if (key.name.endsWith(`:${jobId}`)) {
          await this.kv.delete(key.name);
          break;
        }
      }
    }

    // Update status
    status.status = 'cancelled';
    status.finishedAt = Date.now();
    if (status.startedAt) {
      status.duration = status.finishedAt - status.startedAt;
    }
    await this.updateJobStatus(jobId, status);

    return true;
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId: string): Promise<boolean> {
    // Get original job config from status
    const status = await this.getJobStatus(jobId);
    if (!status || status.status !== 'failure') {
      return false;
    }

    // Get job data (we'll need to store this separately for retries)
    const jobData = await this.kv.get(`job:${jobId}`, 'json') as JobConfig | null;
    if (!jobData) {
      return false;
    }

    // Re-enqueue
    await this.enqueue(jobData);
    return true;
  }

  /**
   * Store job config for retries
   */
  async storeJobConfig(job: JobConfig): Promise<void> {
    await this.kv.put(`job:${job.id}`, JSON.stringify(job), {
      expirationTtl: 7 * 24 * 60 * 60 // 7 days
    });
  }

  /**
   * Clean up completed jobs older than specified age
   */
  async pruneCompletedJobs(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAge;
    const statuses = await this.listJobs();
    let deleted = 0;

    for (const status of statuses) {
      if (
        status.finishedAt &&
        status.finishedAt < cutoff &&
        ['success', 'failure', 'cancelled'].includes(status.status)
      ) {
        await this.kv.delete(`status:${status.id}`);
        await this.kv.delete(`job:${status.id}`);
        deleted++;
      }
    }

    return deleted;
  }
}

