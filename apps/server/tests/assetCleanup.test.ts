import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import sharp from 'sharp';

let app: Express;
let token = '';
let tmpDir = '';

function call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-cleanup-test-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();

  const registered = await call('post', '/api/auth/register', {
    email: 'cleanup@test.local',
    password: 'password123',
    displayName: '清理测试',
  });
  token = registered.body.token;
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function uploadAsset(cardId: string): Promise<{ assetId: string }> {
  const png = await sharp({
    create: { width: 12, height: 12, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .png()
    .toBuffer();
  const res = await request(app)
    .post(`/api/inspirations/${cardId}/assets`)
    .set('authorization', `Bearer ${token}`)
    .attach('files', png, 'scene.png');
  expect(res.status).toBe(201);
  return { assetId: res.body.items[0].assetId as string };
}

describe('删除素材：原图 / 缩略图 / 分享副本失效并清理（文档 11.3 / 13.4）', () => {
  it('上传后磁盘上有原图、缩略图与分享副本，三类访问都可用', async () => {
    const card = await call('post', '/api/inspirations', { title: '待删素材的卡' });
    const cardId = card.body.id as string;
    const { assetId } = await uploadAsset(cardId);

    const fileRes = await call('get', `/api/assets/${assetId}/file`);
    expect(fileRes.status).toBe(200);
    const thumbRes = await call('get', `/api/assets/${assetId}/thumb`);
    expect(thumbRes.status).toBe(200);

    // 创建分享并访问分享图，懒生成 share 目录下的剥离 EXIF 副本
    const link = await call('post', '/api/share-links', {
      scope: 'inspiration',
      scopeId: cardId,
      fuzzLevel: 'g500',
      expiresInDays: 1,
    });
    expect(link.status).toBe(201);
    const shareToken = link.body.token as string;
    const shared = await call('get', `/api/share/${shareToken}/assets/${assetId}`);
    expect(shared.status).toBe(200);

    expect(walkFiles(process.env.UPLOAD_DIR!)).toHaveLength(1);
    expect(walkFiles(process.env.THUMB_DIR!).length).toBeGreaterThan(0);
    expect(walkFiles(process.env.SHARE_DIR!)).toHaveLength(1);
  });

  it('删除成功后三类派生文件全部从磁盘消失，且三种访问立即 404（可重试）', async () => {
    const card = await call('post', '/api/inspirations', { title: '删除闭环的卡' });
    const cardId = card.body.id as string;
    const { assetId } = await uploadAsset(cardId);

    const link = await call('post', '/api/share-links', {
      scope: 'inspiration',
      scopeId: cardId,
      fuzzLevel: 'g500',
      expiresInDays: 1,
    });
    const shareToken = link.body.token as string;
    await call('get', `/api/share/${shareToken}/assets/${assetId}`);
    expect(walkFiles(process.env.SHARE_DIR!).length).toBeGreaterThan(0);

    const del = await call('delete', `/api/assets/${assetId}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    // 原图 + 缩略图 + 分享副本
    expect(del.body.filesRemoved).toBe(3);
    expect(del.body.filesPending).toBe(0);

    // 磁盘：原图、缩略图、分享副本都没了
    const files = [
      ...walkFiles(process.env.UPLOAD_DIR!),
      ...walkFiles(process.env.THUMB_DIR!),
      ...walkFiles(process.env.SHARE_DIR!),
    ].filter((f) => f.includes(assetId));
    expect(files).toHaveLength(0);

    // 派生访问立即失效：原图 / 缩略图走鉴权接口，分享令牌走公开接口
    expect((await call('get', `/api/assets/${assetId}/file`)).status).toBe(404);
    expect((await call('get', `/api/assets/${assetId}/thumb`)).status).toBe(404);
    const shareView = await call('get', `/api/share/${shareToken}/assets/${assetId}`);
    expect(shareView.status).toBe(404);
    // 分享视图本身还在，但资产列表里不再包含该图
    const shareMeta = await call('get', `/api/share/${shareToken}`);
    expect(shareMeta.status).toBe(200);
    expect(shareMeta.body.item.assets.map((a: { id: string }) => a.id)).not.toContain(assetId);

    // 重复删除幂等：行已不存在，返回 404，不会重新产生文件
    const again = await call('delete', `/api/assets/${assetId}`);
    expect(again.status).toBe(404);
  });

  it('文件删除失败时删除仍生效，残留记入清理队列；解除故障后手动重试收敛', async () => {
    const card = await call('post', '/api/inspirations', { title: '删除失败重试的卡' });
    const cardId = card.body.id as string;
    const { assetId } = await uploadAsset(cardId);

    // 制造一次确定的 rm 失败：在原图所在目录中放同名子目录，
    // 则 fs.rmSync(文件路径) 以 ENOTEMPTY/EISDIR 失败（对 root 同样有效）
    const { getDb } = await import('../src/db.js');
    const row = getDb().prepare('SELECT file_path FROM asset WHERE id = ?').get(assetId) as {
      file_path: string;
    };
    fs.rmSync(row.file_path, { force: true });
    fs.mkdirSync(row.file_path, { recursive: true });
    fs.writeFileSync(path.join(row.file_path, 'occupied.txt'), 'x');

    const del = await call('delete', `/api/assets/${assetId}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    // 删除立即生效（行没了），但原图删除失败 → pending；缩略图与分享副本已删
    expect(del.body.filesPending).toBeGreaterThan(0);

    // 原图与缩略图的鉴权访问已经 404（派生访问失效不依赖磁盘清理）
    expect((await call('get', `/api/assets/${assetId}/file`)).status).toBe(404);
    expect((await call('get', `/api/assets/${assetId}/thumb`)).status).toBe(404);

    // 健康巡检能看到待清理项
    const health = await call('get', '/api/health/verify-assets');
    expect(health.status).toBe(200);
    expect(health.body.pendingCleanupCount).toBeGreaterThan(0);
    expect(health.body.pendingCleanups.some((p: { assetId: string }) => p.assetId === assetId)).toBe(true);

    // 解除故障（占住目录的非空目录移除），手动重试
    fs.rmSync(row.file_path, { recursive: true, force: true });
    const retry = await call('post', `/api/assets/${assetId}/cleanup-retry`, {});
    expect(retry.status).toBe(200);
    expect(retry.body.filesRemoved).toBeGreaterThan(0);
    expect(retry.body.filesPending).toBe(0);

    const healthAfter = await call('get', '/api/health/verify-assets');
    expect(healthAfter.body.pendingCleanupCount).toBe(0);

    // 再次重试幂等：没有待处理项
    const retryAgain = await call('post', '/api/assets-cleanup/retry', {});
    expect(retryAgain.status).toBe(200);
    expect(retryAgain.body.filesRemoved).toBe(0);
    expect(retryAgain.body.filesPending).toBe(0);
  });
});
