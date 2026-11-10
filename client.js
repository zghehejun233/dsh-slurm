/**
 * dsh-slurm — browser half.
 *
 * Registers a "Slurm" tab in the right sidebar (dsh-better-sidebar) with one
 * merged job list, a collapsible recent-completions section, and compact
 * cluster capacity. The host serves the merged model at
 * `/api/dsh-slurm/state`; this file only renders it.
 */

window.__ModuleLoader__.load({
  id: 'dsh-slurm',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-slurm'

    const zh = {
      tab: 'Slurm 队列',
      tabDesc: '作业进度、队列与节点资源',
      cluster: '集群',
      selectCluster: '选择集群',
      refresh: '刷新',
      progress: '作业时间预算',
      updated: '更新于',
      auto: '自动刷新',
      noHost: '选择集群后查看队列',
      noHostHint: '从上面的下拉框选一个 dsh-ssh 主机；Agent 也会跟随这个选择。',
      running: '运行',
      pending: '排队',
      completed: '完成',
      active: '当前作业',
      recent: '最近完成',
      noJobs: '还没有作业',
      noJobsHint: '让 Agent 用 slurm_submit 提交；完成后会自动开始新一轮。',
      noRecent: '没有已完成的跟踪作业',
      reason: '原因',
      left: '剩余',
      notified: '已通知',
      notNotified: '未通知',
      tracked: '跟踪',
      stale: '当前显示的是上次成功的数据',
      retry: '重试',
      error: '读取失败',
      otherHosts: '其他集群',
      justNow: '刚刚',
      secondsAgo: '{n}s 前',
      minutesAgo: '{n}m 前',
      hoursAgo: '{n}h 前',
      state: {
        RUNNING: '运行中',
        COMPLETING: '收尾中',
        CONFIGURING: '配置中',
        PENDING: '排队中',
        REQUEUED: '重新排队',
        COMPLETED: '完成',
        FAILED: '失败',
        CANCELLED: '取消',
        TIMEOUT: '超时',
        PREEMPTED: '被抢占',
        NODE_FAIL: '节点故障',
        OUT_OF_MEMORY: '内存不足',
        BOOT_FAIL: '启动失败',
        UNKNOWN: '未知',
        MISSING: '失联',
      },
    }

    const en = {
      tab: 'Slurm queue',
      tabDesc: 'Job progress, queue, and node capacity',
      cluster: 'Cluster',
      selectCluster: 'Select a cluster',
      refresh: 'Refresh',
      progress: 'Job time budget',
      updated: 'Updated',
      auto: 'Auto-refresh',
      noHost: 'Select a cluster to see its queue',
      noHostHint: 'Pick a dsh-ssh host above; the Agent follows this selection.',
      running: 'running',
      pending: 'pending',
      completed: 'done',
      active: 'Active',
      recent: 'Recent',
      noJobs: 'No jobs yet',
      noJobsHint: 'Ask the Agent to submit with slurm_submit; it will wake this chat when done.',
      noRecent: 'No tracked jobs finished yet',
      reason: 'reason',
      left: 'left',
      notified: 'notified',
      notNotified: 'not notified',
      tracked: 'tracked',
      stale: 'Showing the last successful snapshot',
      retry: 'Retry',
      error: 'Read failed',
      otherHosts: 'other clusters',
      justNow: 'just now',
      secondsAgo: '{n}s ago',
      minutesAgo: '{n}m ago',
      hoursAgo: '{n}h ago',
      state: {
        RUNNING: 'running',
        COMPLETING: 'completing',
        CONFIGURING: 'configuring',
        PENDING: 'pending',
        REQUEUED: 'requeued',
        COMPLETED: 'completed',
        FAILED: 'failed',
        CANCELLED: 'cancelled',
        TIMEOUT: 'timeout',
        PREEMPTED: 'preempted',
        NODE_FAIL: 'node fail',
        OUT_OF_MEMORY: 'out of memory',
        BOOT_FAIL: 'boot fail',
        UNKNOWN: 'unknown',
      },
    }

    const T = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l1)',
      bg: 'var(--dsw-alias-bg-base)',
      layer: 'var(--dsw-alias-bg-layer-2)',
      hover: 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))',
      accent: 'var(--dsw-alias-brand-primary)',
      run: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const CSS = `
.dsh-slurm-panel{display:flex;flex-direction:column;height:100%;overflow:auto;box-sizing:border-box;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:1.5;letter-spacing:0}
.dsh-slurm-panel *{box-sizing:border-box}
.dsh-slurm-header{position:sticky;top:0;z-index:2;display:flex;flex-direction:column;gap:8px;
  padding:12px 12px 10px;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-slurm-head-top{display:flex;align-items:center;gap:7px;min-width:0}
.dsh-slurm-title{font-size:13px;font-weight:600;line-height:1.3}
.dsh-slurm-dot{width:6px;height:6px;border-radius:999px;flex:none}
.dsh-slurm-muted{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-slurm-grow{flex:1;min-width:0}
.dsh-slurm-icon-btn{display:grid;place-items:center;width:26px;height:26px;flex:none;padding:0;
  border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-slurm-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.dsh-slurm-icon-btn:disabled{opacity:.55;cursor:default}
.dsh-slurm-icon-btn:focus-visible,.dsh-slurm-select:focus-visible,.dsh-slurm-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-slurm-spin{animation:dsh-slurm-spin .9s linear infinite}
.dsh-slurm-host-row{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsh-slurm-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-slurm-select{width:100%;min-width:0;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px}
.dsh-slurm-select:disabled{opacity:.6}
.dsh-slurm-summary{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-slurm-stale{margin:8px 12px 0;padding:6px 8px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:6px;
  color:var(--dsw-alias-state-warn-primary);font-size:11px}
.dsh-slurm-error{margin:8px 12px 0;padding:7px 8px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:6px;
  color:var(--dsw-alias-state-error-primary);font-size:11px;display:flex;align-items:flex-start;gap:8px}
.dsh-slurm-error span{flex:1;min-width:0;overflow-wrap:anywhere}
.dsh-slurm-error button{flex:none;border:1px solid currentColor;background:transparent;color:inherit;border-radius:5px;
  padding:1px 6px;font-size:11px;cursor:pointer}
.dsh-slurm-section{padding:10px 12px 4px}
.dsh-slurm-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:2px}
.dsh-slurm-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-slurm-count{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-slurm-job{padding:7px 0 8px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.dsh-slurm-job:last-child{border-bottom:0}
.dsh-slurm-job-top{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-slurm-job-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none}
.dsh-slurm-job-name{flex:1;min-width:0;font-size:12.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-slurm-track{width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-brand-primary);flex:none}
.dsh-slurm-pill{flex:none;padding:1px 7px;border-radius:999px;border:1px solid currentColor;font-size:10.5px;font-weight:600;line-height:1.5;white-space:nowrap}
.dsh-slurm-meta-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:3px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-slurm-bar{height:4px;border-radius:999px;margin-top:5px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 18%,transparent)}
.dsh-slurm-bar>i{display:block;height:100%;border-radius:999px;transition:width .4s ease}
.dsh-slurm-reason{margin-top:3px;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-slurm-toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:9px 12px;
  border:0;border-top:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-align:left}
.dsh-slurm-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dsh-slurm-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s ease}
.dsh-slurm-chevron[data-open=true]{transform:rotate(180deg)}
.dsh-slurm-recent-row{display:flex;align-items:center;gap:6px;padding:5px 12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-slurm-recent-row .dsh-slurm-job-id{font-size:10.5px}
.dsh-slurm-recent-row .dsh-slurm-recent-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dsh-slurm-recent-row .dsh-slurm-recent-state{flex:none}
.dsh-slurm-recent-row .dsh-slurm-recent-notify{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.dsh-slurm-cluster-row{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:11px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.dsh-slurm-cluster-row:last-child{border-bottom:0}
.dsh-slurm-cluster-name{flex:none;font-weight:550;color:var(--dsw-alias-label-primary);min-width:62px}
.dsh-slurm-cluster-meta{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-slurm-cpu{flex:none;display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.dsh-slurm-cpu-bar{width:42px;height:3px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 18%,transparent)}
.dsh-slurm-cpu-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
.dsh-slurm-empty{padding:22px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6}
.dsh-slurm-empty strong{display:block;margin-bottom:3px;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}
.dsh-slurm-skeleton{padding:12px}
.dsh-slurm-skeleton-row{height:30px;margin-bottom:10px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);animation:dsh-slurm-pulse 1.4s ease-in-out infinite}
.dsh-slurm-skeleton-row:nth-child(2){animation-delay:.15s;height:26px}
.dsh-slurm-skeleton-row:nth-child(3){animation-delay:.3s;height:22px}
.dsh-slurm-foot{padding:8px 12px 10px;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
@keyframes dsh-slurm-pulse{0%,100%{opacity:.45}50%{opacity:.9}}
@keyframes dsh-slurm-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-slurm-spin,.dsh-slurm-skeleton-row{animation:none}}
`

    function parseClock(value) {
      if (value === undefined || value === null || value === '') return undefined
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
      const text = String(value).trim()
      if (/^\d+$/u.test(text)) return Number(text)
      const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(text)
      if (m === null) return undefined
      return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
    }

    function fmtDuration(seconds) {
      if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) return '—'
      const total = Math.max(0, Math.round(seconds))
      const d = Math.floor(total / 86400)
      const hh = Math.floor((total % 86400) / 3600)
      const mm = Math.floor((total % 3600) / 60)
      const ss = total % 60
      if (d > 0) return `${d}d ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
      if (hh > 0) return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      return `${mm}:${String(ss).padStart(2, '0')}`
    }

    function fmtRelative(iso, now) {
      if (typeof iso !== 'string' || iso === '') return ''
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return ''
      const diff = Math.max(0, now - at)
      if (diff < 5000) return 'just-now'
      if (diff < 60_000) return `s:${Math.floor(diff / 1000)}`
      if (diff < 3_600_000) return `m:${Math.floor(diff / 60_000)}`
      return `h:${Math.floor(diff / 3_600_000)}`
    }

    function relativeText(t, token) {
      if (token === 'just-now') return t('justNow')
      const [unit, n] = token.split(':')
      if (unit === 's') return t('secondsAgo').replace('{n}', n)
      if (unit === 'm') return t('minutesAgo').replace('{n}', n)
      return t('hoursAgo').replace('{n}', n)
    }

    function stateColor(state) {
      if (state === 'RUNNING' || state === 'COMPLETING') return T.run
      if (state === 'PENDING' || state === 'CONFIGURING' || state === 'REQUEUED') return T.warn
      if (state === 'COMPLETED') return T.ok
      if (state === 'CANCELLED' || state === 'PREEMPTED' || state === 'TIMEOUT') return T.warn
      if (state === 'FAILED' || state === 'NODE_FAIL' || state === 'OUT_OF_MEMORY' || state === 'BOOT_FAIL') return T.bad
      return T.idle
    }

    function stateLabel(t, state) {
      const value = t(`state.${state}`)
      return value === `state.${state}` ? state : value
    }

    function formatGres(gres) {
      if (typeof gres !== 'string' || gres === '') return ''
      return gres.split(',').map((part) => {
        const m = /^gpu:([^:]+):(\d+)$/u.exec(part)
        return m === null ? part : `${m[2]}×${m[1].toUpperCase()}`
      }).join(' · ')
    }

    function StatePill({ state, label, small }) {
      const color = stateColor(state)
      return h('span', {
        className: 'dsh-slurm-pill',
        style: {
          color,
          borderColor: color,
          background: `color-mix(in srgb, ${color} 13%, transparent)`,
          ...(small ? { fontSize: '10px', padding: '0 5px' } : {}),
        },
      }, label)
    }

    function Progress({ elapsed, limit, state }) {
      const known = Number.isFinite(elapsed) && Number.isFinite(limit) && limit > 0
      const pct = known ? Math.max(2, Math.min(100, (elapsed / limit) * 100)) : 28
      const color = stateColor(state)
      return h('div', {
        className: 'dsh-slurm-bar',
        role: 'progressbar',
        'aria-label': t('progress'),
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': known ? Math.round(pct) : undefined,
        'aria-valuetext': known ? `${fmtDuration(elapsed)} / ${fmtDuration(limit)}` : fmtDuration(elapsed),
      }, h('i', { style: { width: `${pct}%`, background: color } }))
    }

    function RefreshIcon({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M20 11a8 8 0 1 0-2.34 5.66', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', { d: 'M20 4v7h-7', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function Chevron({ open }) {
      return h('svg', {
        className: 'dsh-slurm-chevron',
        'data-open': String(open),
        width: 12,
        height: 12,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
      }, h('path', { d: 'm6 9 6 6 6-6', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function JobRow({ job, t }) {
      const pending = job.state === 'PENDING' || job.state === 'CONFIGURING' || job.state === 'REQUEUED'
      const elapsed = job.elapsedSec
      const limit = job.limitSec
      const left = job.timeLeftSec
      return h('div', { className: 'dsh-slurm-job' },
        h('div', { className: 'dsh-slurm-job-top' },
          h('span', { className: 'dsh-slurm-job-id' }, `#${job.id}`),
          job.tracked ? h('span', { className: 'dsh-slurm-track', title: t('tracked') }) : null,
          h('span', { className: 'dsh-slurm-job-name', title: job.name }, job.name || '—'),
          h(StatePill, { state: job.state, label: stateLabel(t, job.state) })),
        pending
          ? h('div', { className: 'dsh-slurm-reason' },
              `${t('reason')}: ${job.reason && job.reason !== 'None' ? job.reason : '—'}`,
              left ? ` · ${t('left')} ${fmtDuration(left)}` : '')
          : h(React.Fragment, null,
              h(Progress, { elapsed, limit, state: job.state }),
              h('div', { className: 'dsh-slurm-meta-row' },
                h('span', null, `${fmtDuration(elapsed)}${limit ? ` / ${fmtDuration(limit)}` : ''}`),
                h('span', null, left ? `${t('left')} ${fmtDuration(left)}` : ''),
                job.notifiedAt ? h('span', { title: t('notified') }, '✓') : null)))
    }

    function ClusterSection({ cluster, t }) {
      const partitions = Array.isArray(cluster?.partitions) ? cluster.partitions : []
      const nodes = Array.isArray(cluster?.nodes) ? cluster.nodes : []
      const partitionRows = partitions.map((row, index) => h('div', { className: 'dsh-slurm-cluster-row', key: `p-${row.partition}-${index}` },
        h('span', { className: 'dsh-slurm-cluster-name' }, row.partition),
        h('span', { className: 'dsh-slurm-cluster-meta' }, `${row.nodes ?? 0} node${row.nodes === 1 ? '' : 's'}${row.gres ? ` · ${formatGres(row.gres)}` : ''}`),
        h('span', { className: 'dsh-slurm-cpu' }, row.state || '')))
      const nodeRows = nodes.map((row, index) => {
        const total = Number(row.totalCpus) || 0
        const used = Number(row.allocatedCpus) || 0
        const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
        return h('div', { className: 'dsh-slurm-cluster-row', key: `n-${row.node}-${index}` },
          h('span', { className: 'dsh-slurm-cluster-name', title: row.node }, row.node),
          h('span', { className: 'dsh-slurm-cluster-meta' }, row.gres ? formatGres(row.gres) : '—'),
          h('span', { className: 'dsh-slurm-cpu' },
            h('span', { className: 'dsh-slurm-cpu-bar' }, h('i', { style: { width: `${pct}%` } })),
            `${used}/${total}`))
      })
      if (partitionRows.length === 0 && nodeRows.length === 0) {
        return h('div', { className: 'dsh-slurm-section' },
          h('div', { className: 'dsh-slurm-section-head' }, h('span', { className: 'dsh-slurm-section-title' }, t('cluster'))),
          h('div', { className: 'dsh-slurm-empty' }, '—'))
      }
      return h('div', { className: 'dsh-slurm-section' },
        h('div', { className: 'dsh-slurm-section-head' }, h('span', { className: 'dsh-slurm-section-title' }, t('cluster'))),
        partitionRows,
        nodeRows)
    }

    function Skeleton() {
      return h('div', { className: 'dsh-slurm-skeleton', 'aria-busy': 'true' },
        h('div', { className: 'dsh-slurm-skeleton-row' }),
        h('div', { className: 'dsh-slurm-skeleton-row' }),
        h('div', { className: 'dsh-slurm-skeleton-row' }))
    }

    function SlurmPanel(props) {
      const t = React.useMemo(() => props.ctx.locale.bind(NS), [props.ctx])
      const [data, setData] = React.useState(null)
      const [failure, setFailure] = React.useState('')
      const [switchFailure, setSwitchFailure] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [now, setNow] = React.useState(Date.now())
      const [recentOpen, setRecentOpen] = React.useState(false)
      const alive = React.useRef(true)
      const inflight = React.useRef(null)
      const postRef = React.useRef(null)

      const load = React.useCallback(async () => {
        if (inflight.current !== null) return
        const controller = new AbortController()
        inflight.current = controller
        setBusy(true)
        try {
          const response = await fetch('/api/dsh-slurm/state', { headers: { accept: 'application/json' }, signal: controller.signal })
          const payload = await response.json()
          if (!alive.current) return
          if (payload.ok === false) {
            setFailure(String(payload.error ?? t('error')))
            return
          }
          setData(payload)
          setFailure('')
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(`${t('error')}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          inflight.current = null
          if (alive.current) setBusy(false)
        }
      }, [t])

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false; inflight.current?.abort(); postRef.current?.abort() }
      }, [])

      React.useEffect(() => {
        if (!props.visible) return undefined
        load()
        const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
        const interval = (data?.summary && (data.summary.running + data.summary.pending) > 0
          ? (data.panelRefreshSeconds ?? 8)
          : 20) * 1000
        const timer = setInterval(() => { if (!hidden()) load() }, interval)
        const onVisible = () => { if (!hidden()) load() }
        document.addEventListener('visibilitychange', onVisible)
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
      }, [props.visible, load, data?.summary?.running, data?.summary?.pending, data?.panelRefreshSeconds])

      React.useEffect(() => {
        if (!props.visible) return undefined
        const timer = setInterval(() => setNow(Date.now()), 5000)
        return () => clearInterval(timer)
      }, [props.visible])

      const switchHost = async (host) => {
        postRef.current?.abort()
        const controller = new AbortController()
        postRef.current = controller
        setBusy(true)
        try {
          const response = await fetch('/api/dsh-slurm/host', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ host }),
            signal: controller.signal,
          })
          const payload = await response.json()
          if (!alive.current) return
          if (!response.ok || payload.ok === false) {
            setSwitchFailure(String(payload.error ?? t('error')))
            return
          }
          setSwitchFailure('')
          setFailure('')
          await load()
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setSwitchFailure(`${t('error')}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          if (postRef.current === controller) postRef.current = null
          if (alive.current) setBusy(false)
        }
      }

      const summary = data?.summary ?? { running: 0, pending: 0, completed: 0 }
      const jobs = Array.isArray(data?.jobs) ? data.jobs : []
      const recent = Array.isArray(data?.recent) ? data.recent : []
      const hosts = Array.isArray(data?.hosts) ? data.hosts : []
      const host = data?.host ?? ''
      const updated = fmtRelative(data?.updatedAt, now)
      const dotColor = failure !== '' || switchFailure !== '' || data?.stale ? T.bad : busy ? T.faint : T.ok

      const header = h('div', { className: 'dsh-slurm-header' },
        h('div', { className: 'dsh-slurm-head-top' },
          h('span', { className: 'dsh-slurm-title' }, t('tab')),
          h('span', { className: 'dsh-slurm-dot', style: { background: dotColor }, title: switchFailure || failure || t('auto') }),
          h('span', { className: 'dsh-slurm-muted dsh-slurm-grow' }, updated === '' ? '' : relativeText(t, updated)),
          h('button', {
            type: 'button',
            className: 'dsh-slurm-icon-btn',
            onClick: load,
            disabled: busy,
            'aria-label': t('refresh'),
            title: t('refresh'),
          }, h('span', { className: busy ? 'dsh-slurm-spin' : '' }, h(RefreshIcon)))),
        h('div', { className: 'dsh-slurm-host-row' },
          h('label', { className: 'dsh-slurm-label', htmlFor: 'dsh-slurm-host' }, t('cluster')),
          h('select', {
            id: 'dsh-slurm-host',
            className: 'dsh-slurm-select',
            value: host,
            disabled: busy || hosts.length === 0,
            'aria-label': t('cluster'),
            onChange: (event) => switchHost(event.target.value),
          },
            host === '' ? h('option', { value: '' }, t('selectCluster')) : null,
            hosts.map((row) => h('option', { key: row.ref, value: row.ref, title: row.detail }, row.label)))),
        h('div', { className: 'dsh-slurm-summary', role: 'status' },
          `${summary.running} ${t('running')} · ${summary.pending} ${t('pending')} · ${summary.completed} ${t('completed')}`,
          data?.otherHosts > 0 ? ` · ${data.otherHosts} ${t('otherHosts')}` : ''))

      const body = []
      if (data?.stale) {
        const detail = typeof data.error === 'string' && data.error !== '' ? ` · ${data.error}` : ''
        body.push(h('div', { className: 'dsh-slurm-stale', key: 'stale' }, `${t('stale')}${detail}`))
      }
      if (failure !== '' || switchFailure !== '') body.push(h('div', { className: 'dsh-slurm-error', key: 'err' },
        h('span', null, switchFailure || failure),
        h('button', { type: 'button', onClick: load, disabled: busy }, t('retry'))))

      if (data === null) {
        if (failure === '') body.push(h(Skeleton, { key: 'skeleton' }))
      } else if (host === '') {
        body.push(h('div', { className: 'dsh-slurm-empty', key: 'no-host' },
          h('strong', null, t('noHost')),
          t('noHostHint')))
      } else {
        body.push(h('div', { className: 'dsh-slurm-section', key: 'active' },
          h('div', { className: 'dsh-slurm-section-head' },
            h('span', { className: 'dsh-slurm-section-title' }, t('active')),
            h('span', { className: 'dsh-slurm-count' }, String(jobs.length))),
          jobs.length === 0
            ? h('div', { className: 'dsh-slurm-empty' }, h('strong', null, t('noJobs')), t('noJobsHint'))
            : jobs.map((job) => h(JobRow, { key: `j-${job.id}`, job, t }))))

        if (recent.length > 0) {
          body.push(h('button', {
            type: 'button',
            className: 'dsh-slurm-toggle',
            key: 'recent-toggle',
            'aria-expanded': recentOpen,
            onClick: () => setRecentOpen((open) => !open),
          }, h('span', null, `${t('recent')} (${recent.length})`), h(Chevron, { open: recentOpen })))
          if (recentOpen) {
            body.push(h('div', { key: 'recent-list' }, recent.map((job) => h('div', { className: 'dsh-slurm-recent-row', key: `r-${job.id}` },
              h('span', { className: 'dsh-slurm-job-id' }, `#${job.id}`),
              h('span', { className: 'dsh-slurm-recent-name', title: job.name }, job.name || '—'),
              h('span', { className: 'dsh-slurm-recent-state' }, h(StatePill, { state: job.state, label: stateLabel(t, job.state), small: true })),
              h('span', null, fmtDuration(job.elapsedSec)),
              h('span', { className: 'dsh-slurm-recent-notify', title: job.notifiedAt ? t('notified') : t('notNotified') }, job.notifiedAt ? '✓' : '·')))))
          }
        }
        body.push(h(ClusterSection, { key: 'cluster', cluster: data.cluster, t }))
        body.push(h('div', { className: 'dsh-slurm-foot', key: 'foot' }, `${t('updated')} ${data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : '—'} · ${t('auto')}`))
      }

      return h('div', { className: 'dsh-slurm-panel' }, header, body)
    }

    return {
      inject: ['locale'],
      apply(ctx) {
        let t = (key) => (zh[key] ?? key)
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-slurm: dictionaries')
          t = ctx.locale.bind(NS)
          t('state.RUNNING')
        } catch { /* locale missing: the bundled Chinese strings stay */ }

        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          let style = document.getElementById('dsh-slurm-styles')
          const created = style === null
          if (style === null) {
            style = document.createElement('style')
            style.id = 'dsh-slurm-styles'
            document.head.append(style)
          }
          style.textContent = CSS
          return () => { if (created) style.remove() }
        }, 'dsh-slurm: styles')

        ctx.inject(['betterSidebar'], (sidebarCtx) => {
          sidebarCtx.effect(() => sidebarCtx.betterSidebar.registerTab({
            id: 'dsh-slurm:queue',
            title: () => t('tab'),
            description: () => t('tabDesc'),
            icon: (size) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
              h('rect', { x: 3, y: 4, width: 18, height: 4, rx: 1.5, fill: 'currentColor', opacity: 0.95 }),
              h('rect', { x: 3, y: 10, width: 13, height: 4, rx: 1.5, fill: 'currentColor', opacity: 0.7 }),
              h('rect', { x: 3, y: 16, width: 8, height: 4, rx: 1.5, fill: 'currentColor', opacity: 0.45 }),
              h('circle', { cx: 19, cy: 18, r: 3, fill: 'currentColor' })),
            order: 60,
            single: true,
            component: (panelProps) => h(SlurmPanel, panelProps),
          }), 'dsh-slurm: right sidebar tab')
        })
      },
    }
  },
})
