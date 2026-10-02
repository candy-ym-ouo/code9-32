-- 删除素材后的磁盘清理队列（文档 11.3 / 13.4）：
-- asset 行先被删除（原图/缩略图/分享副本的访问即刻失效），随后才删磁盘文件。
-- 若文件删除失败（占用、权限、瞬时 IO 错误），记录留在本表，由
-- 手动重试接口与定时扫描补偿，保证"数据库已删但文件残留"可以被重试收敛。
CREATE TABLE IF NOT EXISTS file_cleanup (
  id            TEXT PRIMARY KEY,
  library_id    TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  asset_id      TEXT NOT NULL,                 -- 仅用于溯源；asset 行已删，故不加外键
  kind          TEXT NOT NULL CHECK (kind IN ('original', 'thumb', 'share')),
  file_path     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_run_at   TEXT NOT NULL,                 -- 退避后可重试时间
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_cleanup_due
  ON file_cleanup(status, next_run_at);
