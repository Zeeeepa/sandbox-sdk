/**
 * Orchestrator - Main job execution engine
 */

import type { ISandbox } from '@repo/shared';
import { StateManager } from './state-manager';
import { CacheManager } from './cache-manager';
import { JobQueue } from './job-queue';
import type { JobConfig, JobStatus, StepResult } from './types';

export interface OrchestratorDeps {
  sandbox: ISandbox;
  stateManager: StateManager;
  cacheManager: CacheManager;
  jobQueue: JobQueue;
}

export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  /**
   * Execute a complete job
   */
  async executeJob(job: JobConfig): Promise<JobStatus> {
    const { sandbox, stateManager, cacheManager, jobQueue } = this.deps;
    
    // Get current status
    const status = await jobQueue.getJobStatus(job.id);
    if (!status) {
      throw new Error(`Job status not found: ${job.id}`);
    }

    try {
      // Set up workspace
      await this.setupWorkspace(job, sandbox);

      // Restore cache if available
      const cacheHit = await this.restoreCache(job, sandbox, cacheManager);
      console.log(`Cache ${cacheHit ? 'HIT' : 'MISS'} for job ${job.id}`);

      // Execute each step
      for (let i = 0; i < job.steps.length; i++) {
        const step = job.steps[i];
        status.currentStep = i;
        await jobQueue.updateJobStatus(job.id, status);

        const stepResult = await this.executeStep(step, job, sandbox);
        status.steps[i] = stepResult;

        // Stop on failure unless continueOnError is true
        if (stepResult.status === 'failure' && !step.continueOnError) {
          status.status = 'failure';
          status.error = `Step "${step.name}" failed`;
          break;
        }
      }

      // If all steps succeeded, mark as success
      if (status.steps.every(s => s.status === 'success' || s.status === 'skipped')) {
        status.status = 'success';
      }

      // Save cache after successful build
      if (status.status === 'success' && job.cacheKeys && job.cacheKeys.length > 0) {
        await this.saveCache(job, sandbox, cacheManager);
      }

      // Create workspace snapshot
      if (status.status === 'success') {
        await stateManager.createSnapshot(sandbox, job.id, job.commit);
      }

    } catch (error) {
      status.status = 'failure';
      status.error = error instanceof Error ? error.message : String(error);
    } finally {
      status.finishedAt = Date.now();
      if (status.startedAt) {
        status.duration = status.finishedAt - status.startedAt;
      }
      await jobQueue.updateJobStatus(job.id, status);
    }

    return status;
  }

  /**
   * Set up workspace (clone repo, checkout commit)
   */
  private async setupWorkspace(job: JobConfig, sandbox: ISandbox): Promise<void> {
    // Create workspace directory
    await sandbox.exec('mkdir -p /workspace');
    
    // Clone repository
    console.log(`Cloning ${job.repo}...`);
    await sandbox.exec(`git clone ${job.repo} /workspace/repo`, {
      workingDir: '/workspace'
    });

    // Checkout specific commit/branch
    await sandbox.exec(`git checkout ${job.commit}`, {
      workingDir: '/workspace/repo'
    });

    // Set environment variables
    if (job.env) {
      for (const [key, value] of Object.entries(job.env)) {
        await sandbox.exec(`export ${key}="${value}"`);
      }
    }
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    step: JobConfig['steps'][0],
    job: JobConfig,
    sandbox: ISandbox
  ): Promise<StepResult> {
    const result: StepResult = {
      name: step.name,
      status: 'running',
      startedAt: Date.now()
    };

    try {
      console.log(`Executing step: ${step.name}`);
      
      const workingDir = step.workingDir || '/workspace/repo';
      const timeout = step.timeout || 300; // 5 minute default

      // Set step-specific env vars
      if (step.env) {
        for (const [key, value] of Object.entries(step.env)) {
          await sandbox.exec(`export ${key}="${value}"`);
        }
      }

      // Execute command with timeout
      const execResult = await Promise.race([
        sandbox.exec(step.run, { workingDir }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Step timeout')), timeout * 1000)
        )
      ]) as Awaited<ReturnType<typeof sandbox.exec>>;

      result.output = execResult.stdout || execResult.stderr;
      result.exitCode = execResult.exitCode;
      result.status = execResult.exitCode === 0 ? 'success' : 'failure';

    } catch (error) {
      result.status = 'failure';
      result.output = error instanceof Error ? error.message : String(error);
      result.exitCode = 1;
    } finally {
      result.finishedAt = Date.now();
      result.duration = result.finishedAt - result.startedAt;
    }

    return result;
  }

  /**
   * Restore cache from R2
   */
  private async restoreCache(
    job: JobConfig,
    sandbox: ISandbox,
    cacheManager: CacheManager
  ): Promise<boolean> {
    if (!job.cacheKeys || job.cacheKeys.length === 0) {
      return false;
    }

    try {
      const cacheKey = await cacheManager.generateCacheKey(
        job.repo,
        job.commit,
        job.cacheKeys,
        sandbox
      );

      const cacheHit = await cacheManager.restoreCache(cacheKey, sandbox);
      return cacheHit;
    } catch (error) {
      console.error('Cache restore failed:', error);
      return false;
    }
  }

  /**
   * Save cache to R2
   */
  private async saveCache(
    job: JobConfig,
    sandbox: ISandbox,
    cacheManager: CacheManager
  ): Promise<void> {
    if (!job.cacheKeys || job.cacheKeys.length === 0) {
      return;
    }

    try {
      const cacheKey = await cacheManager.generateCacheKey(
        job.repo,
        job.commit,
        job.cacheKeys,
        sandbox
      );

      // Auto-detect project type and cache paths
      const cachePaths = [
        ...CacheManager.getDefaultCachePaths('node'),
        ...CacheManager.getDefaultCachePaths('python'),
        ...CacheManager.getDefaultCachePaths('go')
      ];

      await cacheManager.saveCache(cacheKey, cachePaths, sandbox);
      console.log(`Cache saved: ${cacheKey}`);
    } catch (error) {
      console.error('Cache save failed:', error);
    }
  }

  /**
   * Stream job logs in real-time
   */
  async streamJobLogs(jobId: string): Promise<ReadableStream<string>> {
    const { jobQueue } = this.deps;

    return new ReadableStream({
      async start(controller) {
        let lastStep = -1;

        const interval = setInterval(async () => {
          const status = await jobQueue.getJobStatus(jobId);
          
          if (!status) {
            controller.close();
            clearInterval(interval);
            return;
          }

          // Stream new step outputs
          if (status.currentStep !== undefined && status.currentStep > lastStep) {
            for (let i = lastStep + 1; i <= status.currentStep; i++) {
              const step = status.steps[i];
              if (step && step.output) {
                controller.enqueue(`[${step.name}]\n${step.output}\n\n`);
              }
            }
            lastStep = status.currentStep;
          }

          // Close stream when job finishes
          if (['success', 'failure', 'timeout', 'cancelled'].includes(status.status)) {
            controller.close();
            clearInterval(interval);
          }
        }, 1000);
      }
    });
  }
}

