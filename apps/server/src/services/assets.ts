import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  azimuthAt,
  elevationAt,
  utcToZonedParts,
  zonedTimeToUtc,
  type AssetRole,
  type PaletteColor,
} from '@flil/shared';
import { config } from '../config.js';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { parseExif } from './exif.js';
import { extractPalette } from './paletteExtract.js';
import { emitEvent } from './events.js';
import { logger } from '../logger.js';

export interface AssetRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  role: AssetRole;
  file_path: string;
  thumb_path: string | null;
  mime: string | null;
  width: number;
  height: number;
  bytes: number;
  sha256: string | null;
  shot_at: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  aperture: string | null;
  shutter: string | null;
  has_gps_exif: number;
  palette: string;
  sun_elevation: number | null;
  sun_azimuth: number | null;
  weather_snapshot: string | null;
  created_at: string;
  updated_at: string;
}

function subdir(date = new Date()): string {
  return path.join(String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'));
}

export interface IngestResult {
  assetId: string;
  duplicateOf: string | null;
  hasGpsExif: boolean;
  shotAt: string | null;
  width: number;
  height: number;
}

/**
 * 单张图片入库管线（文档 11.3）：
 * 落盘 → 元数据 → 缩略图 → 主色 → 拍摄时刻太阳位置 → 判重。
 * 注意：EXIF 中的 GPS **默认不落库**，只记录布尔位并提示用户。
 */
export async function ingestAsset(params: {
  libraryId: string;
  inspirationId: string;
  role: AssetRole;
  filename: string;
  buffer: Buffer;
  /** 若已知机位坐标，则用拍摄时刻计算当时太阳位置 */
  spot?: { lat: number; lng: number; tz: string } | null;
}): Promise<IngestResult> {
  const db = getDb();
  const { libraryId, inspirationId, role, buffer, spot } = params;

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = db
    .prepare('SELECT id FROM asset WHERE library_id = ? AND sha256 = ? LIMIT 1')
    .get(libraryId, sha256) as { id: string } | undefined;

  const image = sharp(buffer, { failOn: 'none' });
  const metadata = await image.metadata();
  const exif = parseExif(metadata.exif as Buffer | undefined);

  const dir = path.join(config.uploadDir, libraryId, subdir());
  const thumbDir = path.join(config.thumbDir, libraryId, subdir());
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });

  const id = newId();
  const ext = metadata.format === 'png' ? 'png' : metadata.format === 'webp' ? 'webp' : 'jpg';
  const filePath = path.join(dir, `${id}.${ext}`);
  const thumbPath = path.join(thumbDir, `${id}.webp`);

  await sharp(buffer, { failOn: 'none' })
    .rotate()
    .toFile(filePath)
    .catch(async () => {
      fs.writeFileSync(filePath, buffer);
    });

  await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(thumbPath)
    .catch(() => undefined);

  let palette: PaletteColor[] = [];
  try {
    palette = await extractPalette(filePath);
  } catch (err) {
    logger.warn('palette 提取失败', { assetId: id, error: String(err) });
  }

  let sunElevation: number | null = null;
  let sunAzimuth: number | null = null;
  if (exif.shotAt && spot) {
    const asUtc = exif.shotAt; // EXIF 是"相机本地时间"
    const parts = utcToZonedParts(asUtc, 'UTC');
    const instant = zonedTimeToUtc(spot.tz, parts.year, parts.month, parts.day, parts.hour, parts.minute);
    sunElevation = elevationAt(instant, spot.lat, spot.lng);
    sunAzimuth = azimuthAt(instant, spot.lat, spot.lng);
  }

  const ts = nowIso();
  db.prepare(
    `INSERT INTO asset (id, library_id, inspiration_id, role, file_path, thumb_path, mime, width, height, bytes,
       sha256, shot_at, camera_model, lens, iso, aperture, shutter, has_gps_exif, palette,
       sun_elevation, sun_azimuth, weather_snapshot, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    libraryId,
    inspirationId,
    role,
    filePath,
    thumbPath,
    metadata.format ? `image/${metadata.format}` : 'image/jpeg',
    metadata.width ?? 0,
    metadata.height ?? 0,
    buffer.byteLength,
    sha256,
    exif.shotAt ? exif.shotAt.toISOString() : null,
    exif.cameraModel,
    exif.lens,
    exif.iso,
    exif.aperture,
    exif.shutter,
    exif.hasGps ? 1 : 0,
    toJson(palette),
    sunElevation,
    sunAzimuth,
    null,
    ts,
    ts,
  );

  emitEvent({
    type: 'asset_processed',
    libraryId,
    payload: { assetId: id, inspirationId, width: metadata.width ?? 0, height: metadata.height ?? 0 },
  });

  return {
    assetId: id,
    duplicateOf: existing?.id ?? null,
    hasGpsExif: exif.hasGps,
    shotAt: exif.shotAt ? exif.shotAt.toISOString() : null,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
  };
}

export function assetAbsolutePath(row: AssetRow, kind: 'file' | 'thumb'): string | null {
  const p = kind === 'file' ? row.file_path : row.thumb_path;
  if (!p) return null;
  return p;
}

export function paletteOf(row: AssetRow): PaletteColor[] {
  return parseJson<PaletteColor[]>(row.palette, []);
}

/** 分享图：另存一份并剥离全部 EXIF（文档 11.3 / 13.4） */
export async function shareImageFor(row: AssetRow, libraryId: string): Promise<string> {
  const target = path.join(config.shareDir, libraryId, `${row.id}.jpg`);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await sharp(row.file_path, { failOn: 'none' })
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(target);
  return target;
}

/** 分享图派生文件路径：与 shareImageFor 的落盘规则保持一致（另存并剥离 EXIF） */
export function shareImagePath(assetId: string, libraryId: string): string {
  return path.join(config.shareDir, libraryId, `${assetId}.jpg`);
}

export interface CleanupEntry {
  kind: 'original' | 'thumb' | 'share';
  filePath: string;
}

export interface AssetDeletionResult {
  assetId: string;
  /** 本次调用实际从磁盘删除的派生文件 */
  removed: CleanupEntry[];
  /** 删除失败、已入队等待重试的派生文件 */
  pending: CleanupEntry[];
}

/** 只允许删除媒体目录内的文件，避免库里路径异常时误删其它位置 */
function isPathInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function cleanupEntries(row: AssetRow): CleanupEntry[] {
  const entries: CleanupEntry[] = [{ kind: 'original', filePath: row.file_path }];
  if (row.thumb_path) entries.push({ kind: 'thumb', filePath: row.thumb_path });
  entries.push({ kind: 'share', filePath: shareImagePath(row.id, row.library_id) });
  return entries;
}

/** 失败退避：30s、1m、2m… 上限 1 小时；attempts 从 0 起，首次失败即推迟 30s */
function backoffAt(attempts: number): string {
  const delayMs = Math.min(30_000 * 2 ** attempts, 3_600_000);
  return new Date(Date.now() + delayMs).toISOString();
}

/**
 * 删除单个素材（文档 11.3 / 13.4）：
 * 先在事务内删 asset 行并登记派生文件（原图 / 缩略图 / 分享副本），
 * 行一消失，file、thumb、share 令牌三类访问立刻 404 —— 派生文件同步失效；
 * 随后尽力删除磁盘文件，失败保留清理记录（含退避与错误原因），可重试收敛。
 */
export function deleteAsset(row: AssetRow): AssetDeletionResult {
  const db = getDb();
  const ts = nowIso();
  const entries = cleanupEntries(row);
  const enqueue = db.transaction(() => {
    db.prepare('DELETE FROM asset WHERE id = ?').run(row.id);
    const stmt = db.prepare(
      `INSERT INTO file_cleanup (id, library_id, asset_id, kind, file_path, status, attempts, last_error, next_run_at, created_at, updated_at)
       VALUES (?,?,?,?,?, 'pending', 0, NULL, ?, ?, ?)`,
    );
    for (const entry of entries) {
      stmt.run(newId(), row.library_id, row.id, entry.kind, entry.filePath, ts, ts, ts);
    }
  });
  enqueue();
  // 事务提交后立即尝试删除：绝大多数情况下当场收敛，失败则留在队列里等重试
  const sweep = retryAssetCleanup(row.library_id, row.id);
  return { assetId: row.id, removed: sweep.removed, pending: sweep.pending };
}

function deleteOne(entry: { kind: CleanupEntry['kind']; filePath: string }): { ok: boolean; error?: string } {
  const baseDir =
    entry.kind === 'original'
      ? config.uploadDir
      : entry.kind === 'thumb'
        ? config.thumbDir
        : config.shareDir;
  if (!isPathInside(baseDir, entry.filePath)) {
    // 路径逃逸属数据/程序错误：重试无意义，记录后直接销项，避免误删目录外文件
    logger.error('清理路径越界，跳过删除', { kind: entry.kind, filePath: entry.filePath });
    return { ok: true };
  }
  try {
    fs.rmSync(entry.filePath, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CleanupSweepResult {
  removed: CleanupEntry[];
  pending: CleanupEntry[];
}

/**
 * 重试清理：处理指定范围内 status='pending' 的记录。
 * - 手动重试：includeDue=false 时无视 next_run_at（用户主动要求立刻再试）
 * - 定时扫描：includeDue=true，只跑到期记录
 * 文件已不存在视为清理完成（force 删除本就幂等）。
 */
export function retryAssetCleanup(
  libraryId?: string,
  assetId?: string,
  opts: { includeDue: boolean } = { includeDue: false },
): CleanupSweepResult {
  const db = getDb();
  const where = ['status = ?'];
  const args: string[] = ['pending'];
  if (libraryId) {
    where.push('library_id = ?');
    args.push(libraryId);
  }
  if (assetId) {
    where.push('asset_id = ?');
    args.push(assetId);
  }
  if (opts.includeDue) {
    where.push('next_run_at <= ?');
    args.push(nowIso());
  }
  const rows = db
    .prepare(`SELECT * FROM file_cleanup WHERE ${where.join(' AND ')} ORDER BY next_run_at`)
    .all(...args) as {
    id: string;
    asset_id: string;
    kind: CleanupEntry['kind'];
    file_path: string;
    attempts: number;
  }[];

  const removed: CleanupEntry[] = [];
  const pending: CleanupEntry[] = [];
  for (const r of rows) {
    const result = deleteOne({ kind: r.kind, filePath: r.file_path });
    const entry: CleanupEntry = { kind: r.kind, filePath: r.file_path };
    if (result.ok) {
      db.prepare(
        "UPDATE file_cleanup SET status = 'done', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?",
      ).run(nowIso(), r.id);
      removed.push(entry);
    } else {
      const attempts = r.attempts + 1;
      db.prepare(
        `UPDATE file_cleanup SET attempts = ?, last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      ).run(attempts, result.error ?? 'unknown', backoffAt(attempts - 1), nowIso(), r.id);
      logger.warn('素材文件删除失败，已排入重试', {
        kind: r.kind,
        assetId: r.asset_id,
        attempts,
        error: result.error,
      });
      pending.push(entry);
    }
  }
  return { removed, pending };
}

/** 定时扫描：处理所有库中到期的清理记录 */
export function sweepDueAssetCleanup(): CleanupSweepResult {
  return retryAssetCleanup(undefined, undefined, { includeDue: true });
}

/** 列出某库未完成的清理项（健康巡检/前端重试提示用） */
export function listPendingCleanup(libraryId: string): {
  assetId: string;
  kind: CleanupEntry['kind'];
  attempts: number;
  lastError: string | null;
  nextRunAt: string;
}[] {
  return getDb()
    .prepare(
      `SELECT asset_id AS assetId, kind, attempts, last_error AS lastError, next_run_at AS nextRunAt
       FROM file_cleanup WHERE library_id = ? AND status = 'pending' ORDER BY created_at`,
    )
    .all(libraryId) as {
    assetId: string;
    kind: CleanupEntry['kind'];
    attempts: number;
    lastError: string | null;
    nextRunAt: string;
  }[];
}
