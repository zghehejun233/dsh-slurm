/**
 * Safe result fetching.
 *
 * The transfer uses SFTP batch commands, not a remote shell: the remote path
 * is an SFTP argument, so `;`, `$()` and spaces cannot become commands. The
 * local destination is created fresh under an allowed root and checked with
 * real paths, which rejects a pre-existing symlink escape.
 */

import fs from 'node:fs'
import path from 'node:path'
import { buildSftpArgv } from './ssh.js'

/** Reject paths SFTP cannot represent safely. */
export function assertRemotePath(value) {
  const text = String(value ?? '').trim()
  if (!text.startsWith('/')) throw new Error('remotePath must be absolute.')
  if (/[\0\r\n]/u.test(text)) throw new Error('remotePath contains a control character.')
  return text
}

function inside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`)
}

/**
 * Create a fresh local destination under one of the allowed roots.
 * @param {{localDir: string, cwd: string, resultsRoot: string}} input
 * @returns {string} canonical local directory.
 */
export function prepareLocalTarget({ localDir, cwd, resultsRoot }) {
  fs.mkdirSync(resultsRoot, { recursive: true, mode: 0o700 })
  const roots = [fs.realpathSync(path.resolve(cwd)), fs.realpathSync(path.resolve(resultsRoot))]
  const target = path.resolve(localDir)
  if (fs.existsSync(target)) throw new Error(`Local destination already exists: ${target}`)

  const parent = path.dirname(target)
  const missing = []
  let cursor = parent
  while (!fs.existsSync(cursor)) {
    missing.unshift(cursor)
    const next = path.dirname(cursor)
    if (next === cursor) break
    cursor = next
  }
  const realExisting = fs.realpathSync(cursor)
  if (!roots.some((root) => inside(root, realExisting))) {
    throw new Error(`Refusing to write outside the session workspace or $DSH_HOME/slurm/results: ${target}`)
  }
  for (const dir of missing) {
    fs.mkdirSync(dir, { mode: 0o700 })
    const realDir = fs.realpathSync(dir)
    if (!roots.some((root) => inside(root, realDir))) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw new Error(`Refusing to write through a symlink outside the allowed roots: ${dir}`)
    }
  }
  const realParent = fs.realpathSync(parent)
  if (!roots.some((root) => inside(root, realParent))) {
    throw new Error(`Refusing to write through a symlink outside the allowed roots: ${target}`)
  }
  const canonicalTarget = path.join(realParent, path.basename(target))
  if (fs.existsSync(canonicalTarget)) throw new Error(`Local destination already exists: ${canonicalTarget}`)
  const staging = fs.mkdtempSync(path.join(realParent, '.dsh-fetch-'))
  const realStaging = fs.realpathSync(staging)
  if (!roots.some((root) => inside(root, realStaging))) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw new Error(`Refusing to stage outside the allowed roots: ${canonicalTarget}`)
  }
  return { staging: realStaging, target: canonicalTarget, roots }
}

/** Move the completed private staging directory to the requested destination. */
export function finalizeFetch(staging, target, roots) {
  const previous = process.cwd()
  const realParent = fs.realpathSync(path.dirname(target))
  if (roots !== undefined && !roots.some((root) => inside(root, realParent))) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw new Error(`Refusing to move through a symlink outside the allowed roots: ${target}`)
  }
  const name = path.basename(target)
  if (fs.existsSync(path.join(realParent, name))) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw new Error(`Local destination already exists: ${target}`)
  }
  try {
    // Anchor the final rename to the directory inode, not to a path a local
    // attacker can replace between the check and the move.
    process.chdir(realParent)
    const cwd = fs.realpathSync(process.cwd())
    if (roots !== undefined && !roots.some((root) => inside(root, cwd))) {
      throw new Error(`Refusing to move through a symlink outside the allowed roots: ${target}`)
    }
    if (fs.existsSync(name)) throw new Error(`Local destination already exists: ${target}`)
    fs.renameSync(path.basename(staging), name)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  } finally {
    try { process.chdir(previous) } catch {}
  }
  return target
}

/** Reject any downloaded symlink that resolves outside the fresh destination. */
export function assertNoSymlinkEscape(root) {
  const canonical = fs.realpathSync(root)
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) {
        let target
        try { target = fs.realpathSync(full) } catch { throw new Error(`Downloaded symlink is dangling: ${full}`) }
        if (!inside(canonical, target)) throw new Error(`Downloaded symlink escapes the destination: ${full}`)
        continue
      }
      if (stat.isDirectory()) visit(full)
    }
  }
  visit(canonical)
}

/** Quote one SFTP batch path. */
export function sftpQuote(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/** Run one recursive `get` over SFTP. */
export async function sftpFetch(rt, spec, remotePath, localDir, options = {}) {
  const batch = `get -r ${sftpQuote(remotePath)} ${sftpQuote(localDir)}\n`
  const args = buildSftpArgv(spec)
  const result = await rt.runLocal('sftp', args, {
    input: batch,
    timeoutMs: 300_000,
    signal: options.signal,
  })
  if (result.code !== 0) {
    fs.rmSync(localDir, { recursive: true, force: true })
    throw new Error(`fetch failed: ${(result.stderr || result.stdout || `sftp exited ${String(result.code)}`).trim().slice(0, 500)}`)
  }
  try {
    assertNoSymlinkEscape(localDir)
  } catch (error) {
    fs.rmSync(localDir, { recursive: true, force: true })
    throw error
  }
  return result
}
