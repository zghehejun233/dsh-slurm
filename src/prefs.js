/**
 * Small durable preferences for dsh-slurm.
 *
 * The selected cluster lives here rather than in the plugin config so that
 * switching hosts from the sidebar does not remount the plugin (and does not
 * interrupt the watcher). `config.host` remains the fallback.
 */

import fs from 'node:fs'
import path from 'node:path'
import { slurmHome } from './state.js'

export const PREFS_VERSION = 1

export function prefsFile() {
  return path.join(slurmHome(), 'prefs.json')
}

export class PrefsStore {
  constructor(file = prefsFile()) {
    this.file = file
    this.host = undefined
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (typeof parsed?.host === 'string' && parsed.host.trim() !== '') this.host = parsed.host.trim()
    } catch {
      this.host = undefined
    }
    return this.host
  }

  get() {
    return this.host
  }

  set(host) {
    const next = String(host ?? '').trim()
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ version: PREFS_VERSION, host: next }, null, 2), { mode: 0o600 })
    try { fs.chmodSync(temp, 0o600) } catch {}
    fs.renameSync(temp, this.file)
    this.host = next
  }

  clear() {
    try { fs.unlinkSync(this.file) } catch {}
    this.host = undefined
  }
}
