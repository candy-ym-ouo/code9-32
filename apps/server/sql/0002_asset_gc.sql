-- 素材删除后的派生文件清理台账（文档 11.3）
-- asset 行先删（让派生数据立即失效），原图/缩略图/分享副本登记后异步清理；
-- 文件系统删除可能瞬时失败（占用/权限/IO），失败保留在本表并退避重试，绝不静默丢失。
CREATE TABLE IF NOT EXISTS asset_file_gc (
  id           TEXT PRIMARY KEY,
  library_id   TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  asset_id     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('file', 'thumb', 'share')),
  file_path    TEXT NOT NULL UNIQUE,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  not_before   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_gc_due ON asset_file_gc(status, not_before);
CREATE INDEX IF NOT EXISTS idx_asset_gc_asset ON asset_file_gc(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_gc_library ON asset_file_gc(library_id, status);
