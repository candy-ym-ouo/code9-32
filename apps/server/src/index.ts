import cron from 'node-cron';
import { createApp } from './app.js';
import { config, ensureDirs } from './config.js';
import { migrate, getDb } from './db.js';
import { logger } from './logger.js';
import { scanWindowsForAllLibraries } from './jobs/windowScan.js';
import { dispatchForAllLibraries } from './jobs/dispatch.js';
import { sweepAssetGcForAllLibraries } from './jobs/assetGc.js';

export function bootstrap(): void {
  ensureDirs();
  const applied = migrate();
  if (applied.length) logger.info('数据库迁移已应用', { files: applied });

  const app = createApp();

  // 启动即清理一次：处理服务停机期间到期的删除残留（上次崩溃/占用未删掉的派生文件）
  try {
    const swept = sweepAssetGcForAllLibraries();
    if (swept.removed || swept.totalPending) logger.info('启动派生文件清理', swept);
  } catch (err) {
    logger.warn('启动派生文件清理失败', { error: String(err) });
  }

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

  // 每 30 分钟清理删除素材后残留的原图/缩略图/分享副本（只处理退避到期的记录，带退避重试）
  const assetGcTask = cron.schedule('*/30 * * * *', () => {
    try {
      sweepAssetGcForAllLibraries();
    } catch (err) {
      logger.error('派生文件清理失败', { error: String(err) });
    }
  });

  const shutdown = () => {
    logger.info('正在关闭服务');
    windowTask.stop();
    dailyTask.stop();
    hourlyTask.stop();
    assetGcTask.stop();
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
