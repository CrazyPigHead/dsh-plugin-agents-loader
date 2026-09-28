/**
 * MCP server loader: reads ~/.agents/mcp.json and loads each enabled
 * MCP server (streamable-http 或 stdio) through ctx.plugin() into the
 * running Host.
 *
 * ## 模块解析策略（懒解析 + 多级回退）
 *
 * `@deepseek-ai/dsh-mcp-client` 只存在于 dsh 进程的依赖树中，插件以
 * pnpm link 方式安装时按源码真实路径解析静态 import 无法命中。因此：
 *
 * 1. `createRequire(process.argv[1]).resolve(...)` — 从 dsh bin 的
 *    node_modules 树解析（纯文件系统查询，与 npx 缓存路径无关）；
 * 2. `createRequire(import.meta.url).resolve(...)` — 常规包解析，插件
 *    经 install_bundle 正式安装（peer 依赖落地 profile node_modules）
 *    时命中。
 *
 * 解析与 import 延迟到 loadMcpServers() 内部且 mcp.json 确有服务器时
 * 才执行：模块解析失败只影响 MCP 加载并记录诊断，不会让整个插件
 * 挂掉，也不会影响斜杠命令。
 *
 * @module mcp-loader
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

/** 缓存已加载的 dsh-mcp-client 插件形态。 */
let mcpPluginPromise = null

/**
 * Resolve and load the dsh-mcp-client plugin shape ({apply, inject, name}).
 * Cached per process; failures are thrown to the caller for logging.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
function loadMcpClientPlugin() {
  mcpPluginPromise ??= (async () => {
    const spec = '@deepseek-ai/dsh-mcp-client'
    let modulePath
    const attempts = [
      () => createRequire(process.argv[1]).resolve(spec),
      () => createRequire(import.meta.url).resolve(spec),
    ]
    const errors = []
    for (const attempt of attempts) {
      try {
        modulePath = attempt()
        break
      } catch (e) {
        errors.push(e.message)
      }
    }
    if (!modulePath) {
      throw new Error(`cannot resolve ${spec}: ${errors.join(' | ')}`)
    }
    return import(pathToFileURL(modulePath).href)
  })()
  return mcpPluginPromise
}

/**
 * Replace `{VAR}` / `${VAR}` placeholders in string values with values
 * from `process.env`. A value referencing a missing variable is dropped
 * with a warning instead of being sent with a broken literal placeholder.
 * Resolved values are never logged.
 *
 * @template T
 * @param {Record<string, T>} values - raw values from mcp.json
 * @param {string} what - human label used in the warning
 * @param {(msg: string) => void} warn
 * @returns {Record<string, T>}
 */
function interpolateValues(values, what, warn) {
  const resolved = {}
  for (const [key, value] of Object.entries(values || {})) {
    if (typeof value !== 'string') {
      resolved[key] = value
      continue
    }
    const missing = []
    const interpolated = value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_, dotBrace, brace) => {
        const name = dotBrace || brace
        const envValue = process.env[name]
        if (envValue === undefined) {
          missing.push(name)
          return ''
        }
        return envValue
      }
    )
    if (missing.length > 0) {
      warn(`${what} "${key}": missing env var(s) ${missing.join(', ')} — dropped`)
      continue
    }
    resolved[key] = interpolated
  }
  return resolved
}

/**
 * Build one dsh-mcp-client config from an mcp.json entry.
 *
 * @param {string} key - server key from mcp.json
 * @param {Record<string, unknown>} entry - server entry
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>} config, or null when the entry is skipped
 */
function buildServerConfig(key, entry, warn) {
  // Sanitize serverName to match /^[A-Za-z0-9_-]{1,32}$/
  const serverName = key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'mcp_server'
  const toolCallTimeoutMs = entry.timeoutMs || 60000
  const common = {
    serverName,
    toolCallTimeoutMs,
    failOnStartupError: false,
    reconnect: { enabled: true },
  }

  // 显式 stdio，或没有 url 但有 command 时的隐式 stdio
  if (entry.type === 'stdio' || (!entry.type && entry.command)) {
    if (!entry.command) {
      warn(`Skipping MCP server "${key}": stdio transport requires "command"`)
      return null
    }
    return {
      ...common,
      transport: 'stdio',
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args : [],
      env: interpolateValues(entry.env || {}, 'stdio env', warn),
      cwd: typeof entry.cwd === 'string' ? entry.cwd : process.cwd(),
    }
  }

  // 默认 http（streamable-http）
  if (entry.type && entry.type !== 'http') {
    warn(`Skipping MCP server "${key}": unsupported type "${entry.type}" (expected "http" or "stdio")`)
    return null
  }
  if (!entry.url) {
    warn(`Skipping MCP server "${key}": missing url`)
    return null
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: entry.url,
    headers: interpolateValues(entry.headers, 'MCP header', warn),
  }
}

/**
 * Read mcp.json and load every enabled MCP server into ctx.
 *
 * Each server becomes a sub-fiber through ctx.plugin(); disposal of the
 * generation fiber automatically tears down all of them.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function loadMcpServers(ctx) {
  const logger = ctx.logger('agents-loader')
  const configPath = join(homedir(), '.agents', 'mcp.json')
  if (!existsSync(configPath)) return

  let parsed
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch (e) {
    logger.error('failed to parse mcp.json: %s', e.message)
    return
  }

  const { mcpServers } = parsed
  if (!mcpServers || typeof mcpServers !== 'object') return

  const enabled = Object.entries(mcpServers).filter(
    ([, entry]) => entry && typeof entry === 'object' && entry.enabled !== false
  )
  if (enabled.length === 0) return

  let mcpModule
  try {
    mcpModule = await loadMcpClientPlugin()
  } catch (e) {
    logger.error('%s', e.message)
    return
  }

  const warn = (msg) => logger.info('%s', msg)
  const MCP_PLUGIN = {
    apply: mcpModule.apply,
    inject: mcpModule.inject,
    name: mcpModule.name,
  }

  for (const [key, entry] of enabled) {
    const config = buildServerConfig(key, entry, warn)
    if (!config) continue
    ctx.effect(() => ctx.plugin(MCP_PLUGIN, config), `mcp:${config.serverName}`)
  }
}
