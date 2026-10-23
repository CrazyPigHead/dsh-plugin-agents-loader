# dsh-plugin-agents-loader

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> dsh 全局插件：启动时自动发现并加载 `~/.agents/mcp.json`（MCP 服务器，支持 http 与 stdio）和 `~/.agents/commands/*.md`（斜杠命令）到运行中的 dsh Host，文件变更时自动重载。

适配 dsh `0.2.1-rc.2`（cordis `4.0.5`）。peer 依赖按 dsh 官方包惯例**精确锁定**版本，安装前请阅读[「安装 · 前置要求」](#前置要求)。

## 与 dsh 原生能力的关系

dsh `0.2.1-rc.2` 已把 `~/.agents` 定位为跨工具共享的 agent 配置根（`dsh-home-paths` 的 `resolveAgentsHome`，可用 `$DSH_AGENTS_HOME` 覆盖），且以下内容**已原生支持，无需本插件**：

| `~/.agents/` 下的内容 | 原生支持 |
|---|---|
| `AGENTS.md` | `dsh-agent-instructions` 直接读取（`agents-global` 作用域，与 `~/.dsh/AGENTS.md` 同组去重） |
| `skills/` | `dsh-skill-filesystem` 目录发现 + 原生 watcher 热重载 |
| `mcp.json` | ❌ 无——`dsh-mcp-client` 只能在 cordis 配置里逐实例声明 |
| `commands/*.md` | ❌ 无——`dsh-commands` 只是注册 API，没有文件发现 |

本插件只补齐最后两项；上游将来若原生支持 `mcp.json` / `commands` 发现，本插件即可退役。

## 功能

| 来源 | 加载到 | 行为 |
|------|--------|------|
| `~/.agents/mcp.json` | `ctx.plugin(dsh-mcp-client, …)` | 对每个 `enabled !== false` 的 MCP 服务器创建子 fiber，自动注册其工具为 `mcp__<server>__<tool>`；支持 `http`（streamable-http）与 `stdio` 两种 transport |
| `~/.agents/commands/*.md` | `commands.register(…)` | 每个 `.md` 文件注册一个斜杠命令；frontmatter 的 `description` 用作命令描述，正文在触发时注入 agent |
| `mcp.json` / `commands/` 变更 | generation fiber 重建 | 内置 `fs.watch` + 500ms 防抖：配置文件变化自动销毁并重建全部动态资源，无需重启 |

## 架构

```
src/
├── entry.js              # apply() 主入口：generation fiber + fs.watch 自动重载
├── mcp-loader.js         # MCP 服务器加载（懒解析 dsh-mcp-client，http + stdio）
└── commands-loader.js    # 斜杠命令注册（inject ['commands']）
```

### 启动数据流

```
apply(ctx)
  ├── ctx.plugin(generation)         # 动态资源的可整体销毁容器
  │     ├── loadMcpServers(ctx)      # 异步：读 mcp.json，逐个 ctx.plugin()
  │     └── ctx.inject(['commands']) # 扫描 commands/*.md → register()
  └── fs.watch(mcp.json, commands/)  # 变更 → 防抖 → dispose 旧 generation 重建
```

## 安装

### 前置要求

- dsh `0.2.1-rc.2`（用 `dsh --version` 确认）。peer 依赖按 dsh 官方包惯例**精确锁定**
  版本，安装时 dsh 会在 pnpm 运行前按 peer 声明检查运行时版本：不匹配会直接失败并
  返回 `incompatible-version`，不下载任何内容。确需在其它 dsh 版本上使用时，按错误
  提示登记 version exemption（CLI：`dsh plugin --profile <name> allow-version …`），
  风险自担。
- `pnpm` 可用（dsh 的插件安装经由 pnpm 完成）。

### 方式一：CLI 安装（推荐）

`dsh plugin` 是 dsh 自带的插件管理命令（**不是** `pnpm` 的裸调用），与内置
Plugin Manager 共用同一套包操作和 profile 写锁，自动完成依赖安装、peer 版本检查、
`dsh.profile.bundles` 登记：

```bash
# 直接从 GitHub 安装，无需 clone：
dsh plugin --profile web add https://github.com/CrazyPigHead/dsh-plugin-agents-loader.git

# 或克隆后按本地路径安装（适合自行修改源码）：
git clone https://github.com/CrazyPigHead/dsh-plugin-agents-loader.git
dsh plugin --profile web add /path/to/dsh-plugin-agents-loader
```

HMR 生效的 profile（如 web/tui）安装后**无需重启**即可加载；结果为
`restart-required` 的 profile 重启 dsh 后生效。

> **不要**手改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile
> 目录直接跑 `pnpm`——那会绕过写锁与版本检查，可能与运行中的 Host 产生写入竞争。

### 方式二：让 agent 安装

在启用了 `plugin_manager` 工具的会话（Creator 预设默认启用；其他预设需在 patch 中
启用 `tool-plugin-manager`）里对 agent 说一句：

> 安装 `https://github.com/CrazyPigHead/dsh-plugin-agents-loader`

agent 会调用 `plugin_manager` 工具执行 `install_bundle`（本地路径同理，换成克隆
目录即可）。看到 `application: applied` 即已挂载生效；`restart-required` 则重启
dsh 后生效。

### 方式三：Web 界面

dsh Web 界面侧边栏的「插件」页提供与上述完全相同的图形化安装 / 启停 / 卸载。

### 两种来源的行为差异

| 安装来源 | 形态 | 更新方式 |
|----------|------|----------|
| GitHub URL | 代码进入 profile 的 `node_modules` | 重新执行安装命令装新版本 |
| 本地路径 | `link:<路径>` 软链（可在 profile 的 `package.json` 确认），克隆目录需长期保留 | `git pull` 后重启 dsh（模块缓存原因，见「开发」） |

启停 / 卸载：Web「插件」页、agent（`set_bundle` / `remove_bundle`），卸载的 CLI
等价命令为 `dsh plugin --profile <name> remove dsh-plugin-agents-loader`。

### 验证

```bash
dsh --profile <name> --dump-config | grep -A1 agents-loader
# 应输出：
# - id: agents-loader
#   name: dsh-plugin-agents-loader
```

### 附：安装到底做了什么（供排障，不作为操作指南）

一次成功安装只改 profile 的 `package.json`（`dependencies` 增加一行
`dsh-plugin-agents-loader`，本地路径安装时值为 `link:<路径>`）与
`pnpm-lock.yaml`，并把包名**追加**进 `dsh.profile.bundles` 数组；Host 随即加载
包内 `cordis.patch.yml` 声明的插件行。bundle 名必须与插件 `package.json` 的
`name` 完全一致；profile 的 `cordis.yml`（组合产物）与用户级 `cordis.patch.yml`
都不用动。peer 依赖不会写进 profile（`autoInstallPeers: false`），运行时由插件的
懒解析回退链从 dsh 自身依赖树解析（见「开发」）。若将来发布到 npm，安装命令的
spec 换成版本号（如 `dsh-plugin-agents-loader@0.2.1`）即可。

## 配置

### mcp.json

放在 `~/.agents/mcp.json`：

```json
{
  "mcpServers": {
    "context-7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": { "Authorization": "Bearer {CONTEXT7_API_KEY}" },
      "timeoutMs": 30000
    },
    "local-tool": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "API_KEY": "{MY_API_KEY}" },
      "cwd": "/opt/somewhere"
    },
    "legacy-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": {},
      "enabled": false
    }
  }
}
```

- **`type`**：`"http"`（streamable-http）或 `"stdio"`；省略时按字段推断——有 `url` 走 http，有 `command` 走 stdio。
- **`enabled`**：设为 `false` 跳过该项（默认启用）。
- **`serverName`**：自动从 key 生成（非法字符替换为 `_`，截断到 32 字符），需符合 `/^[A-Za-z0-9_-]{1,32}$/`。
- **`headers` / `env`**：值中的 `{VAR}` / `${VAR}` 占位符用 Host 进程的 `process.env` 插值（日志不打印解析值）；引用不存在的环境变量时该项丢弃并告警。
- **`timeoutMs`**：单次工具调用超时，默认 60000。

### commands/*.md

放在 `~/.agents/commands/`：

```markdown
---
description: 创建 conventional git commit（中文提交信息）
---

## Goal

Create conventional git commits…

## Workflow

1. `git diff --staged` 检查变更
2. `git add <files>` 暂存
3. `git commit -m "<type>[scope]: <description>"`
```

- 文件名（去掉 `.md`）= 命令名，须匹配 `/^[a-z][a-z0-9_-]*$/`
- `description` 取自 YAML frontmatter，未提供时 fallback 到文件名
- 正文 = frontmatter 之后的所有内容，触发时注入 agent 为一条 user 消息

## 开发

### mcp-client 的模块解析（懒解析 + 回退链）

`mcp-loader.js` 依赖 `@deepseek-ai/dsh-mcp-client`，但该包只存在于 dsh 进程的依赖树中。pnpm link 使 Node.js 从插件源码真实路径解析静态 `import`，无法命中 dsh 的依赖。解析按以下顺序在**运行时**尝试（并且只在 mcp.json 确有服务器时才执行）：

1. `createRequire(process.argv[1]).resolve(...)` — dsh bin 上下文（与 npx 缓存 hash 无关）；
2. `createRequire(import.meta.url).resolve(...)` — 常规解析，install_bundle 正式安装（peer 依赖进 profile `node_modules`）时命中。

解析失败只记录 error 并放弃 MCP 加载，不影响斜杠命令——不会像旧版（模块顶层 await）那样让整个插件无法 import。

### 模块缓存与 HMR

pnpm link 的源码目录不在 HMR watch root 内，loader 以 URL 键控原生 `import()`。**修改本插件源码后需重启 dsh 进程**让 Node 加载新模块代次；改 `~/.agents/` 下的 mcp.json / commands 则由插件内置的 fs.watch 自动热重载。

### 命令名约束

- dsh 命令名：`/^[a-z][a-z0-9_-]*$/`
- MCP serverName：`/^[A-Za-z0-9_-]{1,32}$/`，同一 scope 内唯一

## 调试

```bash
# 验证 profile 组合结果
dsh --profile web --dump-config | grep -A2 agents-loader

# 模块加载冒烟测试
node --check src/entry.js
```

### 运行时验证

1. 在 dsh GUI 中键入 `/` 查看命令列表，应看到 `~/.agents/commands/*.md` 中的命令
2. 执行 `/git-commit` 等命令，agent 应收到对应的 workflow 指令
3. MCP 工具以 `mcp__<serverName>__` 前缀出现在工具列表中
4. 修改 `~/.agents/mcp.json` 或增删 `~/.agents/commands/*.md`，Host 日志应出现 `reload scheduled`，随后资源自动重载

## License

[MIT](LICENSE) © CrazyPigHead
