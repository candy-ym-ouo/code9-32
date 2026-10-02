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

/** 分享副本路径（剥离 EXIF 的另存文件）。删除素材时必须连同它一起清理（文档 11.3 / 13.4） */
export function shareCopyPath(row: Pick<AssetRow, 'id'>, libraryId: string): string {
  return path.join(config.shareDir, libraryId, `${row.id}.jpg`);
}

/** 分享图：另存一份并剥离全部 EXIF（文档 11.3 / 13.4） */
export async function shareImageFor(row: AssetRow, libraryId: string): Promise<string> {
  const target = shareCopyPath(row, libraryId);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await sharp(row.file_path, { failOn: 'none' })
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(target);
  return target;
}

export type AssetFileKind = 'file' | 'thumb' | 'share';

/** 删除某素材后所有应清理的派生文件路径：原图、缩略图、分享副本 */
export function derivedPaths(row: AssetRow): { kind: AssetFileKind; file_path: string }[] {
  const out: { kind: AssetFileKind; file_path: string }[] = [{ kind: 'file', file_path: row.file_path }];
  if (row.thumb_path) out.push({ kind: 'thumb', file_path: row.thumb_path });
  // 分享副本按 assetId 确定性命名，无论是否已生成都登记；不存在时首轮清理即视为完成
  out.push({ kind: 'share', file_path: shareCopyPath(row, row.library_id) });
  return out;
}

/** 退避：1m → 2m → 4m … 封顶 24h；attempts 为已重试次数（0 表示还没试过） */
function backoffDelayMs(attempts: number): number {
  const min = 60_000;
  return Math.min(min * 2 ** Math.max(0, attempts), 24 * 3600_000);
}

/**
 * 删除素材：数据库行先删（原图/缩略图/分享链接随即失效），派生文件登记到 asset_file_gc
 * 后立即尽力清理一次；未删成功的保留台账并退避重试（见 sweepAssetFileGc / 定时任务）。
 */
export function deleteAsset(row: AssetRow): { removed: number; pending: number } {
  const db = getDb();
  const ts = nowIso();
  const paths = derivedPaths(row);

  const stage = db.transaction(() => {
    // 先删行：此后 /file、/thumb 与 /share 都查不到该素材（分享令牌范围内图片同步失效）
    db.prepare('DELETE FROM asset WHERE id = ?').run(row.id);
    for (const p of paths) {
      db.prepare(
        `INSERT INTO asset_file_gc (id, library_id, asset_id, kind, file_path, attempts, last_error,
           status, not_before, created_at, updated_at)
         VALUES (?,?,?,?,?, 0, NULL, 'pending', ?, ?, ?)
         ON CONFLICT(file_path) DO NOTHING`,
      ).run(newId(), row.library_id, row.id, p.kind, p.file_path, ts, ts, ts);
    }
  });
  stage();

  return collectAssetGc({
    rows: db
      .prepare('SELECT * FROM asset_file_gc WHERE asset_id = ? AND status = ?')
      .all(row.id, 'pending') as AssetGcRow[],
  });
}

interface AssetGcRow {
  id: string;
  library_id: string;
  asset_id: string;
  kind: AssetFileKind;
  file_path: string;
  attempts: number;
  last_error: string | null;
  status: 'pending' | 'done';
  not_before: string;
  created_at: string;
  updated_at: string;
}

/** 删除单条台账文件；不存在即成功（force + existsSync 双保险，绝不抛 ENOENT） */
function removeGcFile(row: AssetGcRow): void {
  if (!fs.existsSync(row.file_path)) return;
  fs.rmSync(row.file_path, { force: true });
  if (fs.existsSync(row.file_path)) throw new Error('文件删除后仍然存在');
}

interface CollectResult {
  removed: number;
  pending: number;
  attempts: number;
}

function collectAssetGc(opts: { rows: AssetGcRow[] }): CollectResult {
  const db = getDb();
  const ts = nowIso();
  let removed = 0;
  let pending = 0;
  let attempts = 0;
  for (const row of opts.rows) {
    attempts += 1;
    try {
      removeGcFile(row);
      db.prepare('UPDATE asset_file_gc SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?').run(
        'done',
        ts,
        row.id,
      );
      removed += 1;
    } catch (err) {
      const nextAttempts = row.attempts + 1;
      db.prepare(
        `UPDATE asset_file_gc
           SET attempts = ?, last_error = ?, not_before = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        nextAttempts,
        String(err),
        new Date(Date.now() + backoffDelayMs(nextAttempts)).toISOString(),
        ts,
        row.id,
      );
      pending += 1;
      logger.warn('派生文件删除失败，已安排重试', {
        gcId: row.id,
        assetId: row.asset_id,
        kind: row.kind,
        attempts: nextAttempts,
        error: String(err),
      });
    }
  }
  return { removed, pending, attempts };
}

/**
 * 清理到期的待删文件。
 * - force=false：只处理到了 not_before 的记录（定时任务用，遵守退避）；
 * - force=true：忽略 not_before 立即重试（用户在删除接口上点"重试"时用）。
 */
export function sweepAssetFileGc(opts: { libraryId?: string; force?: boolean; limit?: number } = {}): {
  removed: number;
  pending: number;
  scanned: number;
} {
  const db = getDb();
  const limit = Math.min(2000, Math.max(1, opts.limit ?? 500));
  const rows = (
    opts.force
      ? db
          .prepare(
            'SELECT * FROM asset_file_gc WHERE status = ? ORDER BY created_at LIMIT ?',
          )
          .all('pending', limit)
      : db
          .prepare(
            'SELECT * FROM asset_file_gc WHERE status = ? AND not_before <= ? ORDER BY not_before LIMIT ?',
          )
          .all('pending', nowIso(), limit)
  ) as AssetGcRow[];
  const scoped = opts.libraryId ? rows.filter((r) => r.library_id === opts.libraryId) : rows;
  const result = collectAssetGc({ rows: scoped });
  return { removed: result.removed, pending: result.pending, scanned: scoped.length };
}

/** 某库仍未清理的派生文件数（健康巡检 / 删除接口返回用） */
export function pendingAssetGcCount(libraryId?: string): number {
  const db = getDb();
  const row = libraryId
    ? (db
        .prepare('SELECT COUNT(*) AS n FROM asset_file_gc WHERE library_id = ? AND status = ?')
        .get(libraryId, 'pending') as { n: number })
    : (db.prepare('SELECT COUNT(*) AS n FROM asset_file_gc WHERE status = ?').get('pending') as { n: number });
  return row.n;
}
