/**
 * Durable job ledger.
 *
 * The file lives outside the plugin package (under `$DSH_HOME/slurm`) so a
 * remove/reinstall keeps the tracked jobs. Writes are synchronous and atomic:
 * a small file, one writer, and a crash must never leave half a ledger.
 */

import fs from 'node:fs'
import path from 'node:path'
import { controlDir, dshHome } from './config.js'

export const STATE_VERSION = 1

export function slurmHome() {
  return path.join(dshHome(), 'slurm')
}

export function stateFile() {
  return path.join(slurmHome(), 'jobs.json')
}

/** Create the private directories the ledger and SSH control sockets need. */
export function ensureRuntimeDirs() {
  for (const dir of [slurmHome(), controlDir()]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(dir, 0o700) } catch {}
  }
}

function isJob(value) {
  return value !== null && typeof value === 'object' && typeof value.id === 'string' && typeof value.host === 'string'
}

/** Reject a second Host process sharing this `$DSH_HOME`. */
export function acquireWriterLock() {
  const dir = path.join(slurmHome(), 'writer.lock')
  const owner = path.join(dir, 'owner')
  const alive = (pid) => {
    try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
  }
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
  const acquire = () => {
    try {
      fs.mkdirSync(dir, { mode: 0o700 })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let pid
      try {
        const parsed = Number(fs.readFileSync(owner, 'utf8').trim())
        pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
      } catch {}
      if (pid !== undefined && alive(pid)) return false
      let age = Number.POSITIVE_INFINITY
      try { age = Date.now() - fs.statSync(dir).mtimeMs } catch {}
      if (pid === undefined && age < 5000) return false
      remove()
      return acquire()
    }
    try {
      fs.writeFileSync(owner, String(process.pid), { mode: 0o600 })
    } catch (error) {
      remove()
      throw error
    }
    return true
  }
  if (!acquire()) return undefined
  return remove
}

export class JobStore {
  constructor(file = stateFile()) {
    this.file = file
    this.jobs = []
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.jobs = Array.isArray(parsed?.jobs) ? parsed.jobs.filter(isJob) : []
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch {}
      }
      this.jobs = []
    }
    return this.jobs
  }

  save() {
    try {
      this.writeJobs(this.jobs)
    } catch (error) {
      this.load()
      throw error
    }
  }

  writeJobs(jobs) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ version: STATE_VERSION, jobs }, null, 2), { mode: 0o600 })
    try { fs.chmodSync(temp, 0o600) } catch {}
    fs.renameSync(temp, this.file)
  }

  list() {
    return this.jobs
  }

  find(id, host, cluster) {
    const key = String(id)
    return this.jobs.find((job) => job.id === key
      && (host === undefined || job.host === host)
      && (cluster === undefined || (job.cluster ?? '') === cluster))
  }

  upsert(job) {
    const index = this.jobs.findIndex((candidate) => candidate.id === job.id
      && candidate.host === job.host
      && (candidate.cluster ?? '') === (job.cluster ?? ''))
    const next = this.jobs.slice()
    if (index >= 0) next[index] = { ...next[index], ...job, updatedAt: new Date().toISOString() }
    else next.push({ ...job, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    this.writeJobs(next)
    this.jobs = next
  }

  remove(id, host, cluster) {
    const before = this.jobs.length
    const next = this.jobs.filter((job) => !(job.id === String(id)
      && (host === undefined || job.host === host)
      && (cluster === undefined || (job.cluster ?? '') === cluster)))
    if (next.length !== before) {
      this.writeJobs(next)
      this.jobs = next
    }
    return before - next.length
  }

  /** Drop delivered records past the retention window. */
  prune(retentionDays, now = Date.now()) {
    const floor = now - Math.max(1, retentionDays) * 86400000
    const before = this.jobs.length
    const next = this.jobs.filter((job) => {
      const at = job.delivery?.notifiedAt ?? job.notifyFailedAt
      if (at === undefined) return true
      return Date.parse(at) >= floor
    })
    if (next.length !== before) {
      this.writeJobs(next)
      this.jobs = next
    }
    return before - next.length
  }
}
