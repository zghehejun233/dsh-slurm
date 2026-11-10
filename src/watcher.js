/**
 * Completion watcher: observes tracked jobs on a timer and wakes the owning
 * Session exactly when a job reaches a terminal state.
 *
 * The loop is single-flight and costs zero model tokens while waiting; only a
 * delivered completion message starts a turn. SSH failures never change a
 * job's state, they only delay the next look.
 */

import {
  buildWatchCommand,
  mergeJobStates,
  parseSacct,
  parseSections,
  parseSqueue,
} from './slurm.js'
import { shQuote } from './ssh.js'
import { composeCompletionMessage } from './message.js'

const DELIVERY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000]
const MAX_DELIVERY_ATTEMPTS = 5
const MISS_LIMIT = 3
const REQUEUE_GRACE = 3

export class SlurmWatcher {
  constructor(rt) {
    this.rt = rt
    this.timer = undefined
    this.running = false
    this.pending = false
    this.stopped = false
    this.lastPruneDay = undefined
    this.abort = new AbortController()
    this.generation = 0
  }

  start() {
    this.stopped = false
    this.generation += 1
    this.abort = new AbortController()
    const interval = Math.max(15, this.rt.config.pollSeconds) * 1000
    this.timer = setInterval(() => this.kick('interval'), interval)
    this.timer.unref?.()
    this.kick('startup')
  }

  stop() {
    this.stopped = true
    this.generation += 1
    try { this.abort.abort() } catch {}
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Ask for one pass; a concurrent pass finishes first and re-runs once. */
  kick(reason) {
    if (this.stopped) return
    if (this.running) { this.pending = true; return }
    this.running = true
    this.tick(reason)
      .catch((error) => this.rt.log?.warn?.(`[dsh-slurm] watcher pass failed: ${messageOf(error)}`))
      .finally(() => {
        this.running = false
        if (this.pending && !this.stopped) {
          this.pending = false
          this.kick('pending')
        }
      })
  }

  async tick(reason) {
    const generation = this.generation
    this.pruneIfDue()
    const jobs = this.rt.store.list()
    const observing = jobs.filter((job) => job.terminal !== true)
    const hasPendingDelivery = jobs.some((job) => job.terminal === true
      && job.delivery?.notifiedAt === undefined
      && job.notifyFailedAt === undefined
      && (job.delivery?.nextAttemptAt === undefined || Date.parse(job.delivery.nextAttemptAt) <= Date.now()))

    if (observing.length === 0 && !hasPendingDelivery) return

    const byHost = new Map()
    for (const job of observing) {
      const key = `${job.host}\0${job.cluster ?? ''}`
      if (!byHost.has(key)) byHost.set(key, [])
      byHost.get(key).push(job)
    }

    for (const [key, group] of byHost) {
      const [host, cluster] = key.split('\0')
      try {
        const states = await this.observe(host, group.map((job) => job.id), cluster === '' ? undefined : cluster)
        if (this.stopped || generation !== this.generation) return
        for (const job of group) {
          const observed = states.get(job.id)
          if (observed === undefined) continue
          this.applyObservation(job, observed)
        }
        if (this.stopped || generation !== this.generation) return
        this.rt.store.save()
      } catch (error) {
        this.rt.log?.warn?.(`[dsh-slurm] could not observe ${host}: ${messageOf(error)}`)
      }
    }

    if (this.stopped || generation !== this.generation) return
    for (const job of this.rt.store.list()) {
      if (job.terminal !== true) continue
      if (job.delivery?.notifiedAt !== undefined || job.notifyFailedAt !== undefined) continue
      if (job.delivery?.nextAttemptAt !== undefined && Date.parse(job.delivery.nextAttemptAt) > Date.now()) continue
      await this.deliver(job)
    }
    if (reason === 'startup') this.rt.log?.info?.('[dsh-slurm] watcher started')
  }

  pruneIfDue() {
    const day = new Date().toISOString().slice(0, 10)
    if (this.lastPruneDay === day) return
    this.lastPruneDay = day
    try { this.rt.store.prune(this.rt.config.retentionDays) } catch {}
  }

  async observe(host, ids, cluster) {
    const spec = this.rt.resolveHost(host)
    const result = await this.rt.run(spec, buildWatchCommand(ids, { cluster }), { timeoutMs: 30_000, signal: this.abort.signal })
    const sections = parseSections(result.stdout)
    if (result.timedOut || result.truncated) throw new Error('scheduler query was incomplete (timeout or truncated output)')
    if (sections.QUEUE === undefined || sections.SACCT === undefined
      || sections.QUEUE_EXIT === undefined || sections.SACCT_EXIT === undefined) throw new Error('scheduler query framing is incomplete')
    if (!/^\d+$/u.test(String(sections.QUEUE_EXIT).trim()) || !/^\d+$/u.test(String(sections.SACCT_EXIT).trim())) {
      throw new Error('scheduler query exit markers are invalid')
    }
    const queueExit = Number(sections.QUEUE_EXIT)
    const sacctExit = Number(sections.SACCT_EXIT)
    if (result.code !== 0 || queueExit !== 0 || sacctExit !== 0) {
      throw new Error(result.error ?? result.stderr.trim() ?? `scheduler query failed (ssh ${String(result.code)}, squeue ${queueExit}, sacct ${sacctExit})`)
    }
    const queue = parseSqueue(sections.QUEUE ?? '')
    const sacct = parseSacct(sections.SACCT ?? '')
    return mergeJobStates(queue, sacct, ids)
  }

  applyObservation(job, observed) {
    const now = new Date().toISOString()
    job.lastCheckedAt = now
    job.lastState = observed.state
    job.lastSource = observed.source
    if (observed.exitCode) job.exitCode = observed.exitCode
    if (observed.elapsed) job.elapsed = observed.elapsed
    if (observed.nodelist) job.nodeList = observed.nodelist
    if (observed.reason) job.reason = observed.reason

    if (observed.requeueable) {
      job.requeueMisses = (job.requeueMisses ?? 0) + 1
      job.lastState = observed.state
      if (job.requeueMisses >= REQUEUE_GRACE) {
        job.terminal = true
        job.terminalAt = now
        job.terminalNote = `Slurm reported ${observed.state} and no live queue entry for ${REQUEUE_GRACE} checks.`
      }
      return
    }
    job.requeueMisses = 0
    if (observed.terminal) {
      job.terminal = true
      job.terminalAt = now
      job.misses = 0
      return
    }
    if (observed.source === 'none') {
      job.misses = (job.misses ?? 0) + 1
      job.lastState = 'MISSING'
      job.lastError = `Job ${job.id} was not found in squeue or sacct; still tracking.`
      if (job.misses === MISS_LIMIT) {
        this.rt.log?.warn?.(`[dsh-slurm] job ${job.id} has been missing for ${MISS_LIMIT} checks; keeping it tracked`)
      }
      return
    }
    job.misses = 0
    job.lastError = undefined
  }

  async deliver(job) {
    if (this.stopped) return
    job.delivery ??= { mode: 'continue', attempts: 0 }
    try {
      const tail = this.rt.config.logTailLines > 0 && typeof job.logPath === 'string' && job.logPath !== ''
        ? await this.tailLog(job)
        : undefined
      if (this.stopped) return
      const text = composeCompletionMessage({ job, config: this.rt.config, tail })
      if (this.stopped) return
      const receipt = await this.rt.deliver(job.sessionId, text, () => this.stopped)
      if (this.stopped) return
      job.delivery.notifiedAt = new Date().toISOString()
      job.delivery.messageId = receipt?.messageId
      job.delivery.lastError = undefined
      job.delivery.nextAttemptAt = undefined
      job.notifyFailedAt = undefined
      this.rt.store.save()
      this.rt.log?.info?.(`[dsh-slurm] job ${job.id} finished; session ${job.sessionId} woken`)
    } catch (error) {
      if (this.stopped) return
      const attempts = (job.delivery.attempts ?? 0) + 1
      job.delivery.attempts = attempts
      job.delivery.lastError = messageOf(error).slice(0, 500)
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        job.notifyFailedAt = new Date().toISOString()
        job.delivery.nextAttemptAt = undefined
        this.rt.log?.warn?.(`[dsh-slurm] job ${job.id}: giving up after ${attempts} delivery attempts`)
      } else {
        const delay = DELIVERY_BACKOFF_MS[Math.min(attempts - 1, DELIVERY_BACKOFF_MS.length - 1)]
        job.delivery.nextAttemptAt = new Date(Date.now() + delay).toISOString()
        this.rt.log?.warn?.(`[dsh-slurm] job ${job.id}: delivery failed, retrying in ${Math.round(delay / 1000)}s`)
      }
      this.rt.store.save()
    }
  }

  async tailLog(job) {
    try {
      const spec = this.rt.resolveHost(job.host)
      const result = await this.rt.run(
        spec,
        `tail -n ${Math.max(1, this.rt.config.logTailLines)} -- ${shQuote(job.logPath)} 2>&1`,
        { timeoutMs: 15_000, maxBytes: this.rt.config.maxLogBytes, signal: this.abort.signal },
      )
      if (result.code !== 0) return undefined
      return result.stdout
    } catch {
      return undefined
    }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
