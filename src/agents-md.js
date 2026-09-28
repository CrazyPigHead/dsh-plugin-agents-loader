/**
 * One-time migration: symlink ~/.agents/AGENTS.md → ~/.dsh/AGENTS.md
 * Never overwrites an existing destination.
 *
 * After this symlink, dsh's native `dsh-agent-instructions` handles loading
 * and version management automatically, and edits to the source propagate
 * automatically.
 *
 * @module agents-md
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'

/**
 * @param {import('@deepseek-ai/cordis').Context} [ctx] - for diagnostics only
 */
export function tryMigrateAgentsMd(ctx) {
  const logger = ctx?.logger('agents-loader')
  const src = join(homedir(), '.agents', 'AGENTS.md')
  const dshHome = join(homedir(), '.dsh')
  const dest = join(dshHome, 'AGENTS.md')

  // Check if destination already exists (file or symlink) — never overwrite
  try {
    lstatSync(dest)
    return
  } catch {
    // dest doesn't exist, proceed
  }

  if (!existsSync(src)) return // source doesn't exist, nothing to do

  try {
    mkdirSync(dshHome, { recursive: true })
    symlinkSync(src, dest)
    logger?.info('linked ~/.agents/AGENTS.md -> ~/.dsh/AGENTS.md')
  } catch (e) {
    // The migration is optional — log and continue
    logger?.info('AGENTS.md migration skipped: %s', e.message)
  }
}
