/**
 * State Manager - Handles workspace snapshots and restoration via R2
 */

import type { R2Bucket } from '@cloudflare/workers-types';
import type { ISandbox } from '@repo/shared';
import type { WorkspaceSnapshot } from './types';

export class StateManager {
  constructor(private r2: R2Bucket) {}

  /**
   * Create a workspace snapshot by archiving directories to R2
   */
  async createSnapshot(
    sandbox: ISandbox,
    jobId: string,
    commit: string,
    paths: string[] = ['/workspace']
  ): Promise<WorkspaceSnapshot> {
    const timestamp = Date.now();
    const archiveKey = `snapshots/${jobId}/${commit}/${timestamp}.tar.gz`;

    // Create tar archive of workspace
    const tarCommand = `tar -czf /tmp/snapshot.tar.gz ${paths.join(' ')}`;
    await sandbox.exec(tarCommand);

    // Read archive and upload to R2
    const archiveContent = await sandbox.readFile('/tmp/snapshot.tar.gz');
    const archiveBuffer = Buffer.from(archiveContent, 'base64');

    await this.r2.put(archiveKey, archiveBuffer, {
      customMetadata: {
        jobId,
        commit,
        timestamp: timestamp.toString(),
        paths: paths.join(',')
      }
    });

    // Clean up temp file
    await sandbox.exec('rm /tmp/snapshot.tar.gz');

    return {
      jobId,
      sandboxId: 'unknown', // Set by caller
      commit,
      timestamp,
      archivePath: archiveKey,
      size: archiveBuffer.length
    };
  }

  /**
   * Restore workspace from R2 snapshot
   */
  async restoreSnapshot(
    sandbox: ISandbox,
    snapshotKey: string
  ): Promise<void> {
    // Download archive from R2
    const object = await this.r2.get(snapshotKey);
    if (!object) {
      throw new Error(`Snapshot not found: ${snapshotKey}`);
    }

    const archiveBuffer = await object.arrayBuffer();
    const archiveBase64 = Buffer.from(archiveBuffer).toString('base64');

    // Write archive to sandbox
    await sandbox.writeFile('/tmp/restore.tar.gz', archiveBase64);

    // Extract archive
    await sandbox.exec('tar -xzf /tmp/restore.tar.gz -C /');

    // Clean up
    await sandbox.exec('rm /tmp/restore.tar.gz');
  }

  /**
   * Get latest snapshot for a job/commit
   */
  async getLatestSnapshot(
    jobId: string,
    commit: string
  ): Promise<WorkspaceSnapshot | null> {
    const prefix = `snapshots/${jobId}/${commit}/`;
    const list = await this.r2.list({ prefix, limit: 1 });

    if (list.objects.length === 0) {
      return null;
    }

    const obj = list.objects[0];
    const metadata = obj.customMetadata || {};

    return {
      jobId: metadata.jobId || jobId,
      sandboxId: metadata.sandboxId || 'unknown',
      commit: metadata.commit || commit,
      timestamp: parseInt(metadata.timestamp || '0'),
      archivePath: obj.key,
      size: obj.size
    };
  }

  /**
   * Delete old snapshots to save space
   */
  async pruneSnapshots(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAge;
    let deleted = 0;

    const list = await this.r2.list({ prefix: 'snapshots/' });
    
    for (const obj of list.objects) {
      const timestamp = parseInt(obj.customMetadata?.timestamp || '0');
      if (timestamp > 0 && timestamp < cutoff) {
        await this.r2.delete(obj.key);
        deleted++;
      }
    }

    return deleted;
  }
}

