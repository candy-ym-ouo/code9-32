import { getDb } from '../db.js';
import { logger } from '../logger.js';
import { sweepAssetFileGc } from '../services/assets.js';

/**
 * 素材删除后的派生文件兜底清理（文档 11.3）。
 * 删除接口已经同步尽力清理过一次；这里只重试那些当时删除失败、且退避窗口已到的记录，
 * 避免占用/权限/IO 抖动导致原图、缩略图、分享副本永久残留在磁盘上。
 */
export function sweepAssetGcForAllLibraries(): { removed: number; pending: number; totalPending: number } {
  const result = sweepAssetFileGc({ force: false });
  const totalPending = (
    getDb().prepare('SELECT COUNT(*) AS n FROM asset_file_gc WHERE status = ?').get('pending') as { n: number }
  ).n;

  dbJobRun(result.removed, result.pending, totalPending);
  if (result.removed || result.pending) {
    logger.info('派生文件清理完成', { removed: result.removed, pending: result.pending, totalPending });
  }
  return { removed: result.removed, pending: result.pending, totalPending };
}

function dbJobRun(removed: number, pending: number, totalPending: number): void {
  try {
    getDb()
      .prepare('INSERT INTO job_run (id, name, started_at, finished_at, ok, message) VALUES (?,?,?,?,?,?)')
      .run(
        `job${Date.now().toString(36)}`,
        'assetGc',
        new Date().toISOString(),
        new Date().toISOString(),
        pending === 0 ? 1 : 0,
        `removed=${removed} pending=${pending} totalPending=${totalPending}`,
      );
  } catch (err) {
    logger.warn('assetGc job_run 记录失败', { error: String(err) });
  }
}
