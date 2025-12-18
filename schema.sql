-- 1. 账号表 (纯 API 模式)
CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL, -- 备注名
    email         TEXT,          -- 邮箱地址 (用于显示)
    client_id     TEXT,          -- Azure App ID
    client_secret TEXT,          -- Azure App Secret
    refresh_token TEXT,          -- 核心凭据
    access_token  TEXT,          -- 临时凭据 (自动刷新)
    expires_at    INTEGER,       -- 过期时间
    status        INTEGER DEFAULT 1,
    created_at    INTEGER DEFAULT (strftime('%s', 'now'))
);

-- 2. 邮件发送任务表 (保留原功能，去掉 GAS 模式)
CREATE TABLE IF NOT EXISTS send_tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER,
    to_email        TEXT NOT NULL,
    subject         TEXT,
    content         TEXT,
    base_date       DATETIME,      -- 起始时间
    delay_config    TEXT,          -- 随机延迟配置
    next_run_at     INTEGER,       -- 下次运行时间戳
    is_loop         INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'pending',
    success_count   INTEGER DEFAULT 0,
    fail_count      INTEGER DEFAULT 0
);

-- 3. 公开查询规则表 (保留原功能)
CREATE TABLE IF NOT EXISTS access_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    alias           TEXT NOT NULL,
    query_code      TEXT NOT NULL UNIQUE,
    fetch_limit     TEXT DEFAULT '5',
    valid_until     INTEGER,
    match_sender    TEXT,
    match_body      TEXT,
    created_at      INTEGER DEFAULT (strftime('%s', 'now')),
    match_receiver  TEXT
);

CREATE TABLE IF NOT EXISTS filter_groups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    match_sender    TEXT,
    match_receiver  TEXT,
    match_body      TEXT,
    created_at      INTEGER DEFAULT (strftime('%s', 'now'))
);
