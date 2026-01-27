/**
 * CI/CD Engine Types
 */

export interface JobConfig {
  id: string;
  repo: string;
  commit: string;
  branch: string;
  steps: JobStep[];
  env?: Record<string, string>;
  cacheKeys?: string[]; // Lockfiles for cache invalidation
  timeout?: number; // Timeout in seconds
  priority?: number; // Higher = more important
}

export interface JobStep {
  name: string;
  run: string; // Shell command
  workingDir?: string;
  env?: Record<string, string>;
  continueOnError?: boolean;
  timeout?: number;
}

export interface JobStatus {
  id: string;
  status: 'queued' | 'running' | 'success' | 'failure' | 'timeout' | 'cancelled';
  currentStep?: number;
  startedAt?: number;
  finishedAt?: number;
  duration?: number;
  steps: StepResult[];
  sandboxId?: string;
  error?: string;
}

export interface StepResult {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failure' | 'skipped';
  output?: string;
  exitCode?: number;
  duration?: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface CacheKey {
  key: string; // Composite: repo@commit + hash(lockfiles)
  paths: string[]; // Directories to cache (node_modules, .cache, etc.)
  lastUsed: number;
  size?: number;
}

export interface WorkspaceSnapshot {
  jobId: string;
  sandboxId: string;
  commit: string;
  timestamp: number;
  archivePath: string; // R2 key
  size: number;
}

export interface MetricsData {
  jobId: string;
  status: JobStatus['status'];
  duration: number;
  stepsCount: number;
  cacheHit: boolean;
  resourceUsage?: {
    cpuTime?: number;
    memoryPeak?: number;
  };
}

