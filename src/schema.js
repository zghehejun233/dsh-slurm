/**
 * Loader-validated plugin config. Kept apart from `config.js` so the pure
 * helpers (host resolution, defaults) stay importable without the harness SDK.
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULTS, DEFAULT_CONTINUE_PROMPT } from './config.js'

export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  host: z.string().default(DEFAULTS.host),
  workdir: z.string().default(DEFAULTS.workdir),
  pollSeconds: z.number().step(1).min(15).max(600).default(DEFAULTS.pollSeconds),
  panelRefreshSeconds: z.number().step(1).min(3).max(60).default(DEFAULTS.panelRefreshSeconds),
  historyHours: z.number().step(1).min(1).max(720).default(DEFAULTS.historyHours),
  retentionDays: z.number().step(1).min(1).max(365).default(DEFAULTS.retentionDays),
  maxLogBytes: z.number().step(1).min(1024).max(1048576).default(DEFAULTS.maxLogBytes),
  logTailLines: z.number().step(1).min(0).max(500).default(DEFAULTS.logTailLines),
  followUpByDefault: z.boolean().default(DEFAULTS.followUpByDefault),
  continuePrompt: z.string().default(DEFAULT_CONTINUE_PROMPT),
  connectTimeoutMs: z.number().step(1).min(1000).max(120000).default(DEFAULTS.connectTimeoutMs),
  sshExtraArgs: z.array(z.string()).default([]),
})
