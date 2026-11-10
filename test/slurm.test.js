import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertJobId,
  buildSbatchArgv,
  buildStatusCommand,
  buildWatchCommand,
  baseJobId,
  isTerminal,
  mergeJobStates,
  normalizeState,
  parseHistory,
  parseNodes,
  parseSbatchJobId,
  parseScontrolJob,
  parseSections,
  parseSinfo,
  parseSacct,
  parseSqueue,
  sanitizeName,
} from '../src/slurm.js'
import { shQuote, remoteCommand, buildSshArgv, buildScpArgv, buildRsyncSsh } from '../src/ssh.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8')

test('normalizeState strips decorations', () => {
  assert.equal(normalizeState('COMPLETED'), 'COMPLETED')
  assert.equal(normalizeState('CANCELLED+'), 'CANCELLED')
  assert.equal(normalizeState('CANCELLED by 1000'), 'CANCELLED')
  assert.equal(normalizeState('OUT_OF_MEMORY'), 'OUT_OF_MEMORY')
  assert.equal(normalizeState(''), 'UNKNOWN')
})

test('isTerminal classifies scheduler states', () => {
  for (const state of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY']) {
    assert.equal(isTerminal(state), true, state)
  }
  for (const state of ['PENDING', 'RUNNING', 'CONFIGURING', 'COMPLETING', 'REQUEUED', 'SUSPENDED', 'PREEMPTED', 'NODE_FAIL', 'SPECIAL_EXIT']) {
    assert.equal(isTerminal(state), false, state)
  }
})

test('assertJobId accepts plain and array ids only', () => {
  assert.equal(assertJobId('194'), '194')
  assert.equal(assertJobId('194_2'), '194_2')
  assert.throws(() => assertJobId('194; rm -rf /'), /Invalid Slurm job id/)
  assert.throws(() => assertJobId('$(id)'), /Invalid Slurm job id/)
})

test('sanitizeName keeps path components safe', () => {
  assert.equal(sanitizeName('run ci/../x'), 'run_ci_.._x')
  assert.equal(sanitizeName(''), 'job')
  assert.equal(sanitizeName('a'.repeat(90)).length, 64)
})

test('parseSbatchJobId reads --parsable output', () => {
  assert.equal(parseSbatchJobId('194\n'), '194')
  assert.equal(parseSbatchJobId('194;cluster-a\n'), '194')
  assert.equal(parseSbatchJobId('Submitted batch job 194\n'), undefined)
  assert.equal(parseSbatchJobId(''), undefined)
})

test('buildSbatchArgv emits the expected flags', () => {
  const argv = buildSbatchArgv({
    jobName: 'run_ci',
    partition: 'gpu',
    cpus: 8,
    gpus: 1,
    mem: '64G',
    time: '02:00:00',
    workdir: '/home/gsr/proj',
    logPath: '/home/gsr/proj/.dsh-slurm/run_ci-%j.out',
    dependency: 'afterok:191',
    extraArgs: ['--gres=gpu:rtx5090:1'],
    scriptPath: '/home/gsr/proj/.dsh-slurm/run_ci.sbatch',
  })
  assert.equal(argv[0], 'sbatch')
  assert.ok(argv.includes('--parsable'))
  assert.ok(argv.includes('--job-name=run_ci'))
  assert.ok(argv.includes('--partition=gpu'))
  assert.ok(argv.includes('--cpus-per-task=8'))
  assert.ok(argv.includes('--gres=gpu:1'))
  assert.ok(argv.includes('--mem=64G'))
  assert.ok(argv.includes('--time=02:00:00'))
  assert.ok(argv.includes('--chdir=/home/gsr/proj'))
  assert.ok(argv.includes('--dependency=afterok:191'))
  assert.ok(argv.includes('--gres=gpu:rtx5090:1'))
  assert.equal(argv.at(-1), '/home/gsr/proj/.dsh-slurm/run_ci.sbatch')
})

test('shell quoting survives quotes and substitutions', () => {
  assert.equal(shQuote('plain'), "'plain'")
  assert.equal(shQuote("it's"), `'it'\\''s'`)
  assert.equal(shQuote('$(rm -rf /)'), "'$(rm -rf /)'")
  assert.equal(remoteCommand(['sbatch', 'a b']), "'sbatch' 'a b'")
})

test('ssh argv keeps options and uses -- before the target', () => {
  const spec = {
    target: 'gsr@example',
    options: ['BatchMode=yes', 'ConnectTimeout=10'],
    port: 2222,
    keyPath: '/k',
    proxyJump: ['jump1'],
  }
  const argv = buildSshArgv(spec, 'echo hi')
  assert.deepEqual(argv.slice(0, 4), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'])
  assert.ok(argv.includes('-p'))
  assert.ok(argv.includes('2222'))
  assert.ok(argv.includes('-i'))
  assert.ok(argv.includes('/k'))
  assert.ok(argv.includes('-J'))
  assert.ok(argv.includes('jump1'))
  const dash = argv.indexOf('--')
  assert.ok(dash > 0)
  assert.equal(argv[dash + 1], 'gsr@example')
  assert.equal(argv[dash + 2], 'echo hi')
})

test('scp and rsync argv carry the same connection settings', () => {
  const spec = {
    target: 'gsr@example',
    options: ['BatchMode=yes'],
    port: 2222,
    keyPath: '/k',
    proxyJump: [],
  }
  const scp = buildScpArgv(spec, '/remote/dir', '/local/dir')
  assert.ok(scp.includes('-P'))
  assert.ok(scp.includes('2222'))
  assert.ok(scp.includes('-r'))
  assert.ok(scp.includes('gsr@example:/remote/dir'))
  const rsyncSsh = buildRsyncSsh(spec)
  assert.match(rsyncSsh, /^ssh /)
  assert.match(rsyncSsh, /-p 2222/)
  assert.match(rsyncSsh, /-i '\/k'/)
})

test('parseSinfo strips the default-partition marker', () => {
  const rows = parseSinfo(fixture('sinfo.txt'))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { partition: 'gpu', avail: 'up', nodes: 1, state: 'mix', gres: 'gpu:rtx5090:2' })
  assert.equal(rows[1].gres, '')
})

test('parseNodes reads CPU allocation', () => {
  const rows = parseNodes(fixture('nodes.txt'))
  assert.deepEqual(rows[0], {
    node: '112-2x5090',
    allocatedCpus: 16,
    idleCpus: 16,
    totalCpus: 32,
    gres: 'gpu:rtx5090:2',
    state: 'mix',
  })
})

test('parseSqueue keeps queue rows', () => {
  const rows = parseSqueue(fixture('squeue.txt'))
  assert.equal(rows.length, 4)
  assert.equal(rows[1].id, '197')
  assert.equal(rows[1].state, 'RUNNING')
  assert.equal(rows[0].reason, 'Dependency')
})

test('parseSacct drops step rows and normalizes states', () => {
  const rows = parseSacct(fixture('sacct.txt'))
  assert.deepEqual(rows.map((row) => row.id), ['195', '196', '197', '198', '199'])
  assert.equal(rows[3].state, 'CANCELLED')
  assert.equal(rows[4].exitCode, '1:0')
})

test('parseHistory keeps job names and allocation TRES', () => {
  const rows = parseHistory(fixture('history.txt'))
  assert.equal(rows.length, 3)
  assert.equal(rows[1].name, 'p1_trainB')
  assert.equal(rows[1].allocTRES, 'billing=8')
})

test('parseScontrolJob reads the first job line only', () => {
  const job = parseScontrolJob(fixture('scontrol.txt'))
  assert.equal(job.id, '197')
  assert.equal(job.name, 'p1_evalB')
  assert.equal(job.state, 'RUNNING')
  assert.equal(job.workDir, '/home/gsr/irvis_p0/code')
  assert.equal(job.stdOut, '/home/gsr/irvis_p0/logs/p1_evalB_197.log')
})

test('parseSections splits marker-framed output', () => {
  const sections = parseSections('__SINFO__\na\n__QUEUE__\nb\n')
  assert.equal(sections.SINFO.trim(), 'a')
  assert.equal(sections.QUEUE.trim(), 'b')
})

test('buildStatusCommand includes requested sections', () => {
  const command = buildStatusCommand({ historyHours: 6, nodes: true, jobIds: ['197'] })
  assert.match(command, /__SINFO__/)
  assert.match(command, /__QUEUE__/)
  assert.match(command, /__NODES__/)
  assert.match(command, /__HISTORY__/)
  assert.match(command, /__JOBS__/)
  assert.match(command, /now-6hour/)
  assert.match(command, /scontrol show job -o 197/)
})

test('buildWatchCommand rejects injected ids', () => {
  assert.throws(() => buildWatchCommand(['1; rm -rf /']), /Invalid Slurm job id/)
})

test('mergeJobStates prefers squeue, then sacct, and flags unknown', () => {
  const states = mergeJobStates(
    parseSqueue(fixture('squeue.txt')),
    parseSacct(fixture('sacct.txt')),
    ['197', '195', '404', '194'],
  )
  assert.equal(states.get('197').state, 'RUNNING')
  assert.equal(states.get('197').terminal, false)
  assert.equal(states.get('195').terminal, true)
  assert.equal(states.get('195').exitCode, '0:0')
  assert.equal(states.get('404').state, 'UNKNOWN')
  assert.equal(states.get('404').source, 'none')
  assert.equal(states.get('194').terminal, false)
  assert.equal(baseJobId('194_2'), '194')
})

test('parseScontrolJob keeps values containing spaces', () => {
  const job = parseScontrolJob('JobId=7 JobName=a WorkDir=/home/a b StdOut=/home/a b/out.log StdErr=/home/a b/err.log ExitCode=0:0')
  assert.equal(job.workDir, '/home/a b')
  assert.equal(job.stdOut, '/home/a b/out.log')
  assert.equal(job.stdErr, '/home/a b/err.log')
})

test('mergeJobStates handles array tasks and aggregates failures', () => {
  const task = mergeJobStates(
    [{ id: '123_4', state: 'RUNNING', elapsed: '1:00', timeLeft: '2:00', nodelist: 'n1', reason: 'None', timeLimit: '1:00:00' }],
    [],
    ['123_4'],
  )
  assert.equal(task.get('123_4').state, 'RUNNING')
  assert.equal(task.get('123_4').source, 'squeue')

  const parent = mergeJobStates([], [
    { id: '123_1', state: 'COMPLETED', exitCode: '0:0', elapsedRaw: 10 },
    { id: '123_2', state: 'FAILED', exitCode: '1:0', elapsedRaw: 5 },
  ], ['123'])
  assert.equal(parent.get('123').terminal, true)
  assert.equal(parent.get('123').state, 'FAILED')
  assert.equal(parent.get('123').exitCode, '1:0')
})

test('a mixed completed/preempted array is requeueable until grace', () => {
  const state = mergeJobStates([], [
    { id: '123_1', state: 'COMPLETED', exitCode: '0:0', elapsedRaw: 10 },
    { id: '123_2', state: 'PREEMPTED', exitCode: '0:0', elapsedRaw: 5 },
  ], ['123']).get('123')
  assert.equal(state.terminal, false)
  assert.equal(state.requeueable, true)
})

test('buildWatchCommand carries a cluster flag when tracking a cluster-qualified id', () => {
  assert.match(buildWatchCommand(['123'], { cluster: 'cluster-a' }), /-M 'cluster-a'/)
  assert.doesNotMatch(buildWatchCommand(['123']), /-M/)
})

test('status includes a cluster flag for a tracked cluster job', () => {
  assert.match(
    buildStatusCommand({ historyHours: 0, nodes: false, jobIds: ['197'], jobClusters: { 197: 'cluster-a' } }),
    /scontrol show job -M 'cluster-a' -o 197/,
  )
})
