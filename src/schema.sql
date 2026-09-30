-- 小型铁路站场进路联锁推演台 数据库结构
-- 全部业务状态保存在本地 SQLite，刷新/重启后恢复

PRAGMA foreign_keys = ON;

-- 键值元数据（初始化标记、每客户端事件序号由各自表维护）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 轨道区段
CREATE TABLE IF NOT EXISTS sections (
  id     TEXT PRIMARY KEY,            -- 区段编号，如 1、3DG
  label  TEXT NOT NULL,
  x1     REAL NOT NULL,               -- SVG 端点坐标（画图用）
  y1     REAL NOT NULL,
  x2     REAL NOT NULL,
  y2     REAL NOT NULL,
  -- 占用状态: unknown 未知(按占用处理) / free 空闲 / occupied 占用
  occ_state TEXT NOT NULL DEFAULT 'unknown'
     CHECK (occ_state IN ('unknown','free','occupied')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 道岔：position N=定位(直股) R=反位(弯股)；实际位置以本表为准
CREATE TABLE IF NOT EXISTS switches (
  id       TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  x        REAL NOT NULL,             -- 岔心坐标
  y        REAL NOT NULL,
  position TEXT NOT NULL DEFAULT 'N' CHECK (position IN ('N','R')),
  -- 三组连接端点坐标，用于画直股/弯股两条线路
  nx1 REAL, ny1 REAL, nx2 REAL, ny2 REAL,   -- 定位(直股) 两端
  rx1 REAL, ry1 REAL, rx2 REAL, ry2 REAL,   -- 反位(弯股) 两端
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 信号机
CREATE TABLE IF NOT EXISTS signals (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  x         REAL NOT NULL,
  y         REAL NOT NULL,
  direction TEXT NOT NULL DEFAULT 'right'   -- 朝向，仅画图用
     CHECK (direction IN ('right','left','up','down')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 进路定义（起终点）
CREATE TABLE IF NOT EXISTS routes (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  origin      TEXT NOT NULL,          -- 起点(信号机/站场端部)编号或名称
  destination TEXT NOT NULL,
  entry_signal_id TEXT REFERENCES signals(id) ON DELETE SET NULL, -- 入口信号机
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 进路顺序步：依次经过的区段，以及该进路要求的道岔位置
CREATE TABLE IF NOT EXISTS route_steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id   TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,        -- 从 1 开始
  section_id TEXT NOT NULL REFERENCES sections(id),
  UNIQUE (route_id, step_order)
);

CREATE TABLE IF NOT EXISTS route_switch_reqs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id   TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  switch_id  TEXT NOT NULL REFERENCES switches(id),
  req_position TEXT NOT NULL CHECK (req_position IN ('N','R')),
  UNIQUE (route_id, switch_id)
);

-- 值班员会话（姓名 + 登录令牌）
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  role        TEXT NOT NULL CHECK (role IN ('admin','dispatcher')),
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 已开放（锁闭中）的进路实例
CREATE TABLE IF NOT EXISTS route_instances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id    TEXT NOT NULL REFERENCES routes(id),
  opened_by   TEXT NOT NULL,          -- 值班员姓名
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','released')),
  -- 信号状态：red 红灯(关闭/停车) green 绿灯(允许)
  signal_state TEXT NOT NULL DEFAULT 'green' CHECK (signal_state IN ('red','green')),
  -- 下一个允许的事件序号（严格递增，从 1 开始）
  next_seq    INTEGER NOT NULL DEFAULT 1,
  -- 当前可进入(占用)的步号，从 1 起
  head_step   INTEGER NOT NULL DEFAULT 1,
  -- 当前可出清(清空)的最早步号，从 1 起；越过末步则整条进路解除
  tail_step   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT
);

-- 进路实例锁：开放时写入，逐段解锁/整条解除时删除对应行。
-- 唯一约束保证同一区段/道岔同一时刻只被一条进路锁定（争用仲裁核心）。
CREATE TABLE IF NOT EXISTS route_locks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES route_instances(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('section','switch')),
  resource_id   TEXT NOT NULL,
  step_order INTEGER,                 -- 区段锁对应的进路步号（道岔锁为空）
  UNIQUE (resource_type, resource_id)
);

-- 占用/清空事件流水（幂等与序号审计依据）
CREATE TABLE IF NOT EXISTS section_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES route_instances(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,       -- 进路实例内递增序号
  section_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('occupy','clear')),
  client      TEXT,                   -- 提交人
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (instance_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_locks_instance ON route_locks(instance_id);
CREATE INDEX IF NOT EXISTS idx_events_instance ON section_events(instance_id, seq);
CREATE INDEX IF NOT EXISTS idx_steps_route ON route_steps(route_id, step_order);
