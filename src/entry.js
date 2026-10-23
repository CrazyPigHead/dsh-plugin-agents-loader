/**
 * dsh-plugin-agents-loader — Auto-discover and load:
 *   1. ~/.agents/mcp.json  → MCP servers (http + stdio) via ctx.plugin()
 *   2. ~/.agents/commands/ → slash commands via commands.register()
 *
 * 注：~/.agents/AGENTS.md 自 dsh 0.2.1-rc.2 起由原生 dsh-agent-instructions
 * 直接读取（agents-global 作用域），本插件不再做软链迁移。
 *
 * 所有动态资源装进一个可整体销毁的 generation fiber：
 * mcp.json / commands 目录内容变化时，销毁旧 generation 并重建，
 * 无需重启 dsh 进程。
 *
 * @module dsh-plugin-agents-loader
 */

import { watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadMcpServers } from './mcp-loader.js'
import { loadCommands } from './commands-loader.js'

const AGENTS_DIR = join(homedir(), '.agents')
const COMMANDS_DIR = join(AGENTS_DIR, 'commands')

/** 防抖窗口（毫秒）：watch 事件常常成簇到达。 */
const RELOAD_DEBOUNCE_MS = 500

/**
 * One generation of dynamically loaded resources. Everything registered
 * here (MCP sub-fibers, slash commands) is disposed together.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function applyGeneration(ctx) {
  // 1. MCP servers — 懒解析 dsh-mcp-client 模块
  loadMcpServers(ctx)

  // 2. Slash commands — must wait for `commands` service
  ctx.inject(['commands'], (commandCtx) => {
    loadCommands(commandCtx)
  })
}

const GENERATION_PLUGIN = {
  name: 'agents-loader-generation',
  apply: applyGeneration,
}

/**
 * Plugin entry point.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  let generation = ctx.plugin(GENERATION_PLUGIN)
  let reloadTimer = null

  const scheduleReload = (reason) => {
    ctx.logger('agents-loader').info('reload scheduled (%s)', reason)
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      generation.dispose()
      generation = ctx.plugin(GENERATION_PLUGIN)
    }, RELOAD_DEBOUNCE_MS)
  }
  ctx.effect(() => () => clearTimeout(reloadTimer), 'reload-debounce')

  // 监听配置来源：
  //   - ~/.agents 目录（按 filename 过滤 mcp.json；目录 watch 不受
  //     mcp.json 原子替换换 inode 的影响）
  //   - ~/.agents/commands 目录（顶层 *.md 的增删改）
  // 注意：对不存在路径的 fs.watch 会异步抛 ENOENT，因此必须先确认
  // 路径存在，并始终挂 error 处理器。
  for (const [target, label, match] of [
    [AGENTS_DIR, 'mcp.json', (f) => f === 'mcp.json'],
    [COMMANDS_DIR, 'commands/', () => true],
  ]) {
    try {
      const watcher = watch(
        target,
        { persistent: false },
        (_eventType, filename) => {
          if (typeof filename === 'string' && match(filename)) {
            scheduleReload(label + ' changed')
          }
        }
      )
      watcher.on('error', (e) => {
        // 例如目标被移除：静默停止该监听，不再自动重载
        ctx.logger('agents-loader').info('watch stopped (%s): %s', label, e.message)
        watcher.close()
      })
      // effect 立即执行 body：只返回 close，不要在 body 里关掉 watcher
      ctx.effect(() => () => watcher.close(), `watch:${label}`)
    } catch {
      // 目标不存在：首次 generation 扫描时自然为空
    }
  }
}

export default { apply }
