# CalDAV Worker

基于 [Cloudflare Workers](https://workers.cloudflare.com) + [D1](https://developers.cloudflare.com/d1/) 的个人日历服务器，支持多用户、CalDAV 协议，可通过 Thunderbird 等客户端同步。

## 功能

- **CalDAV 协议支持** — PROPFIND / REPORT / GET / PUT / DELETE / MKCALENDAR / OPTIONS
- **多用户系统** — 独立日历隔离，PBKDF2 密码哈希，URL 路径所有权校验
- **iCalendar 导入** — 支持解析 .ics 文件批量导入事件（含时区转换）
- **Thunderbird 兼容** — 完整的 principal discovery、supported-report-set、calendar-component-set

## 架构

```
Browser / Thunderbird (CalDAV Client)
        │
        ▼
┌──────────────────┐
│  Cloudflare Worker │  src/index.js   路由 + API
│                    │  src/auth.js    Basic Auth（D1 优先，env 回退）
│                    │  src/users.js   PBKDF2 密码 + 用户 CRUD
│                    │  src/db.js      D1 数据访问层
│                    │  src/xml.js     CalDAV XML 构建
│                    │  src/ical.js    iCalendar 解析/生成
└──────┬───────────┘
       │
       ▼
┌──────────────┐
│  D1 Database  │  users / calendars / events
└──────────────┘
```

### 数据表

| 表 | 说明 |
|------|------|
| `users` | 用户名 + PBKDF2 密码哈希 |
| `calendars` | 日历集合，按 `owner` 隔离 |
| `events` | 日历事件，DTSTART/DTEND 存 UTC |

### API 端点

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| `POST` | `/api/register` | admin 密码 | 注册新用户（自动建默认日历） |
| `POST` | `/api/change-password` | Basic Auth | 修改自己的密码 |
| `POST` | `/api/change-username` | Basic Auth | 修改自己的用户名 |
| `POST` | `/api/delete-user` | admin 密码 | 删除用户及所有数据 |
| 全部 | `/:username/...` | Basic Auth | CalDAV 协议（所有权校验） |

## 快速开始

### 前置条件

- Node.js 18+
- Cloudflare 账号
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 部署

```bash
npm install

# 创建 D1 数据库
npx wrangler d1 create caldav-db

# 更新 wrangler.jsonc 中的 database_id

# 执行迁移
npx wrangler d1 execute caldav-db --remote --file=migrations/001_schema.sql
npx wrangler d1 execute caldav-db --remote --file=migrations/003_users.sql

# 部署
npx wrangler deploy
```

### 注册管理员

```bash
# 方式 1：API 注册（部署后首次无用户时）
curl -X POST https://your-worker.workers.dev/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"yourpassword","adminPassword":"bootstrap"}'

# 方式 2：Python 脚本
python3 manage-users.py register admin -p yourpassword -a bootstrap
```

> 首次注册时，`adminPassword` 会回退检查 env secrets 中的 `AUTH_PASSWORD`。

### 导入现有日历数据

```bash
node import-events.js
npx wrangler d1 execute caldav-db --remote --file=migrations/002_import_events.sql
```

## 账号管理

```bash
# 注册新用户（需 admin 密码）
python3 manage-users.py register zhangsan -p mypass -a adminpass

# 修改密码
python3 manage-users.py change-password zhangsan -o old -n new

# 修改用户名
python3 manage-users.py change-username zhangsan lisi -p mypass

# 删除用户
python3 manage-users.py delete-user zhangsan -a adminpass
```

密码参数 `-p` / `-a` / `-o` / `-n` 均可省略，省略时交互隐藏输入，避免特殊字符和 shell 历史问题。

## Thunderbird 连接

1. 打开 Thunderbird → 新建日历 → 存储在网络上 → CalDAV
2. 填入：
   - **用户名**：你的用户名
   - **密码**：你的密码
   - **位置**：`https://your-worker.workers.dev/username/default/`

> 如果用自定义域名（如 `myfreebot.dpdns.org`），需要在 Cloudflare Dashboard 配置 Worker 路由。

## 开发

```bash
npm run dev      # 本地开发（http://0.0.0.0:8787）
npm test         # 运行测试
npm run deploy   # 部署
```

本地 D1 命令加 `--local`：

```bash
npx wrangler d1 execute caldav-db --local --command="SELECT * FROM users;"
```

## 安全

- 密码使用 **PBKDF2** (SHA-256, 100,000 次迭代) 哈希存储
- URL 路径所有权校验：`/zhangsan/` 只能由 `zhangsan` 用户访问
- admin 不可被删除
- `.dev.vars` / `.ics` / `002_import_events.sql` 已加入 `.gitignore`

## 目录结构

```
src/
├── index.js       # Worker 入口 + CalDAV 路由 + API 路由
├── auth.js        # Basic Auth（D1 优先，env secrets 回退）
├── users.js       # 注册、认证、密码修改、用户删除
├── db.js          # 日历和事件的 D1 CRUD
├── xml.js         # CalDAV XML 构建（multistatus/propfind/report）
└── ical.js        # iCalendar 解析/生成（含 TZID→UTC 转换）
migrations/
├── 001_schema.sql # calendars + events 表
└── 003_users.sql  # users 表
test/
└── index.spec.js  # Vitest 测试
manage-users.py    # 账号管理 CLI
import-events.js   # .ics 批量导入
```
