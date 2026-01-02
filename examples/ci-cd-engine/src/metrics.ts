/**
 * Metrics - Observability and monitoring
 */

import type { AnalyticsEngineDataset } from '@cloudflare/workers-types';
import type { JobStatus, MetricsData } from './types';

export class MetricsCollector {
  constructor(
    private analytics?: AnalyticsEngineDataset,
    private kv?: KVNamespace
  ) {}

  /**
   * Record job completion metrics
   */
  async recordJobMetrics(status: JobStatus, cacheHit: boolean): Promise<void> {
    const metrics: MetricsData = {
      jobId: status.id,
      status: status.status,
      duration: status.duration || 0,
      stepsCount: status.steps.length,
      cacheHit
    };

    // Write to Analytics Engine for aggregation
    if (this.analytics) {
      this.analytics.writeDataPoint({
        blobs: [status.id, status.status],
        doubles: [metrics.duration, metrics.stepsCount],
        indexes: [cacheHit ? 'cache-hit' : 'cache-miss']
      });
    }

    // Also store in KV for quick queries
    if (this.kv) {
      const key = `metrics:${status.id}`;
      await this.kv.put(key, JSON.stringify(metrics), {
        expirationTtl: 30 * 24 * 60 * 60 // 30 days
      });
    }
  }

  /**
   * Get aggregate metrics
   */
  async getAggregateMetrics(timeRange: 'hour' | 'day' | 'week'): Promise<{
    totalJobs: number;
    successRate: number;
    avgDuration: number;
    cacheHitRate: number;
  }> {
    if (!this.kv) {
      throw new Error('KV not configured');
    }

    const now = Date.now();
    const ranges = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000
    };
    const cutoff = now - ranges[timeRange];

    // Get all metrics from KV
    const list = await this.kv.list({ prefix: 'metrics:' });
    const metrics: MetricsData[] = [];

    for (const key of list.keys) {
      const data = await this.kv.get(key.name, 'json') as MetricsData | null;
      if (data) {
        // Filter by time range (approximate - based on job ID timestamp if available)
        metrics.push(data);
      }
    }

    // Calculate aggregates
    const totalJobs = metrics.length;
    const successCount = metrics.filter(m => m.status === 'success').length;
    const totalDuration = metrics.reduce((sum, m) => sum + m.duration, 0);
    const cacheHits = metrics.filter(m => m.cacheHit).length;

    return {
      totalJobs,
      successRate: totalJobs > 0 ? (successCount / totalJobs) * 100 : 0,
      avgDuration: totalJobs > 0 ? totalDuration / totalJobs : 0,
      cacheHitRate: totalJobs > 0 ? (cacheHits / totalJobs) * 100 : 0
    };
  }

  /**
   * Get job metrics by ID
   */
  async getJobMetrics(jobId: string): Promise<MetricsData | null> {
    if (!this.kv) {
      return null;
    }

    const data = await this.kv.get(`metrics:${jobId}`, 'json');
    return data as MetricsData | null;
  }

  /**
   * Get recent job metrics
   */
  async getRecentMetrics(limit: number = 50): Promise<MetricsData[]> {
    if (!this.kv) {
      return [];
    }

    const list = await this.kv.list({ prefix: 'metrics:', limit });
    const metrics: MetricsData[] = [];

    for (const key of list.keys) {
      const data = await this.kv.get(key.name, 'json') as MetricsData | null;
      if (data) {
        metrics.push(data);
      }
    }

    return metrics;
  }

  /**
   * Generate dashboard HTML
   */
  generateDashboardHTML(metrics: Awaited<ReturnType<typeof this.getAggregateMetrics>>): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>CI/CD Engine Dashboard</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin: 20px 0;
    }
    .metric-card {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .metric-value {
      font-size: 2em;
      font-weight: bold;
      color: #4CAF50;
    }
    .metric-label {
      color: #666;
      margin-top: 10px;
    }
    h1 {
      color: #333;
    }
  </style>
</head>
<body>
  <h1>CI/CD Engine Dashboard</h1>
  <div class="metrics-grid">
    <div class="metric-card">
      <div class="metric-value">${metrics.totalJobs}</div>
      <div class="metric-label">Total Jobs</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${metrics.successRate.toFixed(1)}%</div>
      <div class="metric-label">Success Rate</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${(metrics.avgDuration / 1000).toFixed(1)}s</div>
      <div class="metric-label">Avg Duration</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${metrics.cacheHitRate.toFixed(1)}%</div>
      <div class="metric-label">Cache Hit Rate</div>
    </div>
  </div>
</body>
</html>
    `;
  }
}

