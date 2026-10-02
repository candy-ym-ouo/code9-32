import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

let app: Express;
let token = '';
let tmpDir = '';
let cardId = '';
let libraryId = '';

function authReq(method: 'get' | 'post' | 'delete', url: string, body?: unknown) {
  let req = request(app)[method](url).set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

interface Uploaded {
  assetId: string;
  file: string;
  thumb: string;
  share: string;
}

async function uploadAsset(): Promise<Uploaded> {
  const png = await sharp({
    create: { width: 24, height: 24, channels: 3, background: { r: 12, g: 60, b: 200 } },
  })
    .png()
    .toBuffer();

  const up = await authReq('post', `/api/inspirations/${cardId}/assets`)
    .field('role', 'reference')
    .attach('files', png, 'probe.png');
  expect(up.status).toBe(201);
  const assetId = up.body.items[0].assetId as string;

  const row = getDb().prepare('SELECT file_path, thumb_path FROM asset WHERE id = ?').get(assetId) as {
    file_path: string;
    thumb_path: string | null;
  };
  const { shareCopyPath } = await import('../src/services/assets.js');
  return { assetId, file: row.file_path, thumb: row.thumb_path as string, share: shareCopyPath({ id: assetId }, libraryId) };
}

let getDb: typeof import('../src/db.js').getDb;

function insertGcRow(p: {
  id: string;
  assetId: string;
  kind: 'file' | 'thumb' | 'share';
  filePath: string;
  notBefore: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO asset_file_gc (id, library_id, asset_id, kind, file_path, attempts, last_error,
         status, not_before, created_at, updated_at)
       VALUES (?,?,?,?,?, 0, NULL, 'pending', ?, ?, ?)`,
    )
    .run(p.id, libraryId, p.assetId, p.kind, p.filePath, p.notBefore, p.notBefore, p.notBefore);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-gc-test-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { getDb: getDbImpl, migrate } = await import('../src/db.js');
  migrate();
  getDb = getDbImpl;
  app = createApp();

  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'gc-owner@test.local', password: 'password123', displayName: '清理测试者' });
  expect(reg.status).toBe(201);
  token = reg.body.token;

  const card = await authReq('post', '/api/inspirations', { title: '删除清理测试卡' });
  cardId = card.body.id;
  libraryId = (getDb().prepare('SELECT library_id FROM inspiration WHERE id = ?').get(cardId) as {
    library_id: string;
  }).library_id;
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('素材删除：派生文件失效与清理', () => {
  it('删除后原图、缩略图、分享副本都从磁盘消失，且素材记录与分享图片立即失效', async () => {
    const { assetId, file, thumb, share } = await uploadAsset();

    // 先生成分享副本（公开分享访问会另存一份剥离 EXIF 的 jpg）
    const link = await authReq('post', '/api/share-links', {
      scope: 'inspiration',
      scopeId: cardId,
      fuzzLevel: 'g500',
      expiresInDays: 1,
    });
    expect(link.status).toBe(201);
    const shareToken = link.body.token as string;
    const sharedBefore = await request(app).get(`/api/share/${shareToken}/assets/${assetId}`);
    expect(sharedBefore.status).toBe(200);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(thumb)).toBe(true);
    expect(fs.existsSync(share)).toBe(true);

    const del = await authReq('delete', `/api/assets/${assetId}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(del.body.filesRemoved).toBe(3);
    expect(del.body.filesPending).toBe(0);

    // 原图 / 缩略图 / 分享副本全部清理
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(thumb)).toBe(false);
    expect(fs.existsSync(share)).toBe(false);

    // 素材记录已删：鉴权接口与公开分享令牌范围内的图片都立即失效
    const file404 = await authReq('get', `/api/assets/${assetId}/file`);
    expect(file404.status).toBe(404);
    const sharedAfter = await request(app).get(`/api/share/${shareToken}/assets/${assetId}`);
    expect(sharedAfter.status).toBe(404);

    // 台账已结清，巡检无残留
    const verify = await authReq('get', '/api/health/verify-assets');
    expect(verify.body.pendingGcTotal).toBe(0);
  });

  it('文件删除失败时登记台账（不阻塞删除），手动重试成功后清零', async () => {
    const { sweepAssetFileGc } = await import('../src/services/assets.js');
    const { assetId } = await uploadAsset();
    await authReq('delete', `/api/assets/${assetId}`);

    // 人为制造一条删不掉的台账记录：目标是一个非空目录（无 recursive 的 rm 必失败，含 root）
    const blocked = path.join(tmpDir, 'blocked-dir');
    fs.mkdirSync(path.join(blocked, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(blocked, 'inner', 'keep.txt'), 'x');
    const future = new Date(Date.now() + 3600_000).toISOString();
    insertGcRow({ id: `gc${Date.now().toString(36)}a`, assetId, kind: 'file', filePath: blocked, notBefore: future });

    // 未到退避窗口的定时扫描不动它
    const skipped = sweepAssetFileGc({ force: false });
    expect(skipped.scanned).toBe(0);
    expect(fs.existsSync(blocked)).toBe(true);

    // 手动重试（force）：尝试删除，失败但保留台账并累计 attempts / 记录错误原因
    const retryFail = await authReq('post', '/api/asset-gc/retry', {});
    expect(retryFail.status).toBe(200);
    expect(retryFail.body.pending).toBe(1);
    expect(retryFail.body.ok).toBe(false);
    const gcRow = getDb().prepare('SELECT * FROM asset_file_gc WHERE file_path = ?').get(blocked) as {
      attempts: number;
      last_error: string | null;
      not_before: string;
    };
    expect(gcRow.attempts).toBe(1);
    expect(gcRow.last_error).toBeTruthy();
    // 退避窗口被推到未来
    expect(new Date(gcRow.not_before).getTime()).toBeGreaterThan(Date.now());

    // 解除阻碍后再次重试 → 清理成功，残留清零
    fs.rmSync(blocked, { recursive: true, force: true });
    const retryOk = await authReq('post', '/api/asset-gc/retry', {});
    expect(retryOk.status).toBe(200);
    expect(retryOk.body.pending).toBe(0);
    expect(retryOk.body.ok).toBe(true);
    const left = getDb().prepare("SELECT COUNT(*) AS n FROM asset_file_gc WHERE status = 'pending'").get() as {
      n: number;
    };
    expect(left.n).toBe(0);
  });

  it('退避窗口到达后定时兜底扫描自动清理', async () => {
    const { sweepAssetFileGc } = await import('../src/services/assets.js');
    const { assetId } = await uploadAsset();
    await authReq('delete', `/api/assets/${assetId}`);

    // 造一条到期待清的残留，验证兜底扫描路径
    const leftover = path.join(tmpDir, 'leftover-share.jpg');
    fs.writeFileSync(leftover, 'stale');
    const past = new Date(Date.now() - 1000).toISOString();
    insertGcRow({ id: `gc${Date.now().toString(36)}b`, assetId, kind: 'share', filePath: leftover, notBefore: past });

    const swept = sweepAssetFileGc({ force: false });
    expect(swept.removed).toBe(1);
    expect(swept.pending).toBe(0);
    expect(fs.existsSync(leftover)).toBe(false);
  });
});
