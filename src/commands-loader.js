/**
 * Slash-command loader: reads ~/.agents/commands/*.md and registers
 * each as a human-visible slash command on ctx.commands.
 *
 * Each .md file = one command. The basename (minus .md) is the command
 * name; YAML frontmatter provides the description. The file body is
 * injected as a workflow instruction into the receiving agent.
 *
 * @module commands-loader
 */

import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'

/**
 * Parse minimal YAML frontmatter from a Markdown document.
 *
 * Handles only scalar key-value pairs (the only shape used by
 * ~/.agents/commands/ files). Returns the extracted metadata and
 * the body (everything after the closing `---`).
 *
 * @param {string} content - full Markdown file content
 * @returns {{ body: string, meta: Record<string, string> }}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { body: content, meta: {} }

  const meta = /** @type {Record<string, string>} */ ({})
  for (const line of match[1].split('\n')) {
    const kvMatch = line.match(/^(\w[\w_-]*)\s*:\s*(.+)$/)
    if (!kvMatch) continue
    let value = kvMatch[2].trim()
    // Strip surrounding single or double quotes
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    meta[kvMatch[1]] = value
  }

  return { body: match[2], meta }
}

/** Mint one pending-message id unique across this process. */
function mintMessageId() {
  return `agentscmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Read the commands directory and register every valid *.md file
 * as a slash command on the commands-injected context.
 *
 * @param {import('@deepseek-ai/cordis').Context} commandCtx - context injected with ['commands']
 */
export function loadCommands(commandCtx) {
  const logger = commandCtx.logger('agents-loader')
  const commandsDir = join(homedir(), '.agents', 'commands')

  let files
  try {
    files = readdirSync(commandsDir).sort()
  } catch {
    return // 目录不存在或不可读：静默跳过
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue

    const name = basename(file, '.md')

    // Validate command name: /^[a-z][a-z0-9_-]*$/
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      logger.info('skipping command "%s": invalid name (must match /^[a-z][a-z0-9_-]*$/)', name)
      continue
    }

    let content
    try {
      content = readFileSync(join(commandsDir, file), 'utf-8')
    } catch (e) {
      logger.info('failed to read command file %s: %s', file, e.message)
      continue
    }

    const { body, meta } = parseFrontmatter(content)
    const description = meta.description || name

    commandCtx.effect(
      () =>
        commandCtx.commands.register({
          name,
          description,
          input: { hint: '[补充要求]' },
          handler: ({ agent, rawInput }) => {
            const extra = rawInput.trim()
            const text = extra ? `${body}\n\n## 补充要求\n\n${extra}` : body
            agent.steer({
              id: mintMessageId(),
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            })
            return {
              kind: 'success',
              text: extra
                ? `已下发 ${name} 工作流指令（含补充要求）`
                : `已下发 ${name} 工作流指令`,
            }
          },
        }),
      `command:${name}`
    )
  }
}
