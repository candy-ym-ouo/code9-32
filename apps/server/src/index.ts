import cron from 'node-cron';
import { createApp } from './app.js';
import { config, ensureDirs } from './config.js';
import { migrate, getDb } from './db.js';
import { logger } from './logger.js';
import { scanWindowsForAllLibraries } from './jobs/windowScan.js';
import { dispatchForAllLibraries } from './jobs/dispatch.js';
import { sweepDueAssetCleanup } from './services/assets.js';

export function bootstrap(): void {
  ensureDirs();
  const applied = migrate();
  if (applied.length) logger.info('数据库迁移已应用', { files: applied });

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info('服务已启动', {
      port: config.port,
      web: config.webOrigin,
      weatherProvider: config.weatherProvider,
      db: config.databaseFile,
    });
    process.stdout.write(
      `\n  电影取景灵感库 API → http://localhost:${config.port}\n  前端开发服务器 → ${config.webOrigin}\n\n`,
    );
  });

  // 每小时重算未来窗口（预报会变，判定必须跟着变）
  const windowTask = cron.schedule(config.windowScanCron, () => {
    void scanWindowsForAllLibraries().catch((err) => logger.error('窗口扫描失败', { error: String(err) }));
  });

  // 启动时 + 每 5 分钟补偿重试删除失败的素材文件（原图/缩略图/分享副本）
  const runCleanupSweep = () => {
    try {
      const result = sweepDueAssetCleanup();
      if (result.removed.length || result.pending.length) {
        logger.info('素材文件清理扫描完成', { removed: result.removed.length, pending: result.pending.length });
      }
    } catch (err) {
      logger.error('素材文件清理扫描失败', { error: String(err) });
    }
  };
  runCleanupSweep();
  const cleanupTask = cron.schedule('*/5 * * * *', runCleanupSweep);

  // 每日 08:10 求值规则并派发提醒；每小时兜底派发一次（带幂等）
  const dailyTask = cron.schedule('10 8 * * *', () => {
    void dispatchForAllLibraries({ evaluate: true }).catch((err) =>
      logger.error('提醒派发失败', { error: String(err) }),
    );
  });
  const hourlyTask = cron.schedule('5 * * * *', () => {
    void dispatchForAllLibraries({ evaluate: false }).catch((err) =>
      logger.error('提醒兜底派发失败', { error: String(err) }),
    );
  });

  const shutdown = () => {
    logger.info('正在关闭服务');
    windowTask.stop();
    cleanupTask.stop();
    dailyTask.stop();
    hourlyTask.stop();
    server.close(() => {
      try {
        getDb().close();
      } catch {
        /* 忽略关闭异常 */
      }
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && process.argv[1].endsWith('index.ts');
if (isMain || process.env.START_SERVER === 'true') bootstrap();
