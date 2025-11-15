/**
 * Cache Manager - Handles dependency caching with smart invalidation
 */

import type { R2Bucket } from '@cloudflare/workers-types';
import type { ISandbox } from '@repo/shared';
import type { CacheKey } from './types';
import { createHash } from 'crypto';

export class CacheManager {
  constructor(
    private r2: R2Bucket,
    private kv: KVNamespace
  ) {}

  /**
   * Generate cache key from repo, commit, and lockfiles
   */
  async generateCacheKey(
    repo: string,
    commit: string,
    lockfiles: string[],
    sandbox?: ISandbox
  ): Promise<string> {
    const parts = [repo, commit];

    // Hash lockfile contents for cache invalidation
    if (sandbox && lockfiles.length > 0) {
      const lockfileContents: string[] = [];
      
      for (const lockfile of lockfiles) {
        try {
          const content = await sandbox.readFile(lockfile);
          lockfileContents.push(content);
        } catch {
          // Lockfile doesn't exist, skip
        }
      }

      if (lockfileContents.length > 0) {
        const hash = createHash('sha256')
          .update(lockfileContents.join(''))
          .digest('hex')
          .slice(0, 12);
        parts.push(hash);
      }
    }

    return parts.join('-');
  }

  /**
   * Save cache directories to R2
   */
  async saveCache(
    cacheKey: string,
    paths: string[],
    sandbox: ISandbox
  ): Promise<CacheKey> {
    const archiveKey = `cache/${cacheKey}.tar.gz`;
    const timestamp = Date.now();

    // Create archive of cache directories
    const existingPaths: string[] = [];
    for (const path of paths) {
      const result = await sandbox.exec(`test -d ${path} && echo exists || echo missing`);
      if (result.stdout?.trim() === 'exists') {
        existingPaths.push(path);
      }
    }

    if (existingPaths.length === 0) {
      throw new Error('No cache directories found to archive');
    }

    const tarCommand = `tar -czf /tmp/cache.tar.gz ${existingPaths.join(' ')}`;
    await sandbox.exec(tarCommand);

    // Upload to R2
    const archiveContent = await sandbox.readFile('/tmp/cache.tar.gz');
    const archiveBuffer = Buffer.from(archiveContent, 'base64');

    await this.r2.put(archiveKey, archiveBuffer, {
      customMetadata: {
        cacheKey,
        paths: paths.join(','),
        timestamp: timestamp.toString(),
        size: archiveBuffer.length.toString()
      }
    });

    // Clean up
    await sandbox.exec('rm /tmp/cache.tar.gz');

    // Store cache metadata in KV
    const cacheMetadata: CacheKey = {
      key: cacheKey,
      paths,
      lastUsed: timestamp,
      size: archiveBuffer.length
    };
    await this.kv.put(`cache:${cacheKey}`, JSON.stringify(cacheMetadata), {
      expirationTtl: 30 * 24 * 60 * 60 // 30 days
    });

    return cacheMetadata;
  }

  /**
   * Restore cache from R2
   */
  async restoreCache(
    cacheKey: string,
    sandbox: ISandbox
  ): Promise<boolean> {
    const archiveKey = `cache/${cacheKey}.tar.gz`;

    // Check if cache exists
    const object = await this.r2.get(archiveKey);
    if (!object) {
      return false; // Cache miss
    }

    // Download and extract
    const archiveBuffer = await object.arrayBuffer();
    const archiveBase64 = Buffer.from(archiveBuffer).toString('base64');

    await sandbox.writeFile('/tmp/cache.tar.gz', archiveBase64);
    await sandbox.exec('tar -xzf /tmp/cache.tar.gz -C /');
    await sandbox.exec('rm /tmp/cache.tar.gz');

    // Update last used timestamp
    const metadata = await this.kv.get(`cache:${cacheKey}`, 'json') as CacheKey | null;
    if (metadata) {
      metadata.lastUsed = Date.now();
      await this.kv.put(`cache:${cacheKey}`, JSON.stringify(metadata), {
        expirationTtl: 30 * 24 * 60 * 60
      });
    }

    return true; // Cache hit
  }

  /**
   * Check if cache exists
   */
  async cacheExists(cacheKey: string): Promise<boolean> {
    const archiveKey = `cache/${cacheKey}.tar.gz`;
    const head = await this.r2.head(archiveKey);
    return head !== null;
  }

  /**
   * List all caches
   */
  async listCaches(): Promise<CacheKey[]> {
    const list = await this.r2.list({ prefix: 'cache/' });
    const caches: CacheKey[] = [];

    for (const obj of list.objects) {
      const metadata = obj.customMetadata || {};
      caches.push({
        key: metadata.cacheKey || obj.key.replace('cache/', '').replace('.tar.gz', ''),
        paths: (metadata.paths || '').split(',').filter(Boolean),
        lastUsed: parseInt(metadata.timestamp || '0'),
        size: obj.size
      });
    }

    return caches;
  }

  /**
   * Prune old caches
   */
  async pruneCaches(maxAge: number = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAge;
    let deleted = 0;

    const list = await this.r2.list({ prefix: 'cache/' });
    
    for (const obj of list.objects) {
      const timestamp = parseInt(obj.customMetadata?.timestamp || '0');
      if (timestamp > 0 && timestamp < cutoff) {
        await this.r2.delete(obj.key);
        
        // Delete KV metadata
        const cacheKey = obj.customMetadata?.cacheKey;
        if (cacheKey) {
          await this.kv.delete(`cache:${cacheKey}`);
        }
        
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * Get common cache paths for different project types
   */
  static getDefaultCachePaths(projectType: 'node' | 'python' | 'go' | 'rust'): string[] {
    const paths: Record<string, string[]> = {
      node: ['node_modules', '.npm', '.yarn/cache'],
      python: ['.venv', '__pycache__', '.pip-cache', '.cache/pip'],
      go: ['go/pkg/mod', '.cache/go-build'],
      rust: ['target', '.cargo/registry', '.cargo/git']
    };
    return paths[projectType] || [];
  }
}

