/**
 * Hermes Desktop — Usage Panel (right sidebar)
 *
 * Shows per-session token consumption, cache utilization (hit rate), context
 * fill, API calls and estimated cost — Kilocode-style, in a right pane.
 *
 * Data sources:
 *   - host.request('session.usage')            live in-memory usage (RPC)
 *   - host.request('session.context_breakdown') context window fill (RPC)
 *   - ctx.rest('/usage/<session_id>')          persisted cache/cost rows from
 *     state.db via the Python backend (plugins/usage-panel/dashboard/)
 *
 * Install: ~/.hermes/desktop-plugins/usage-panel/plugin.js (folder == id).
 * The Python backend must also be installed and enabled:
 *   ~/.hermes/plugins/usage-panel/plugin.yaml
 *   ~/.hermes/plugins/usage-panel/dashboard/{manifest.json,plugin_api.py}
 *   hermes plugins enable usage-panel
 * then restart the desktop backend once (mounts /api/plugins/usage-panel/*).
 * The pane itself hot-loads — run "Reload desktop plugins" from Cmd+K.
 */

import { host, useValue, usePluginI18n } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useRef, useState } from 'react'

const ID = 'usage-panel'

// Gateway events that imply the usage numbers may have changed.
const REFRESH_EVENTS = new Set([
  'message.complete',
  'message.start',
  'message.interim',
  'session.usage',
  'session.info',
  'session.resume',
  'session.create',
  'session.compress',
  'session.branch',
  'session.title',
  'session.activate',
])

// Gentle fallback poll (local RPCs are cheap); events drive the fast path.
const POLL_MS = 20000

/* ── tiny formatting helpers ─────────────────────────────────────────── */

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const v = Number(n)
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(v))
}

function fmtUsd(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  const n = Number(v)
  if (n >= 1000) return '$' + n.toFixed(0)
  return '$' + n.toFixed(2)
}

function pctOf(part, whole) {
  if (!whole) return null
  return Math.round((part / whole) * 100)
}

const T = {
  label: { color: 'var(--ui-text-secondary)' },
  dim: { color: 'var(--ui-text-quaternary)' },
  strong: { color: 'var(--ui-text-primary)' },
  mono: { fontVariantNumeric: 'tabular-nums' },
  track: { background: 'var(--ui-stroke-secondary)', borderRadius: 3, height: 6, overflow: 'hidden' },
  fill: { background: 'var(--ui-accent)', height: '100%', borderRadius: 3 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
}

/* ── data hook: shared by pane and statusbar chip ───────────────────── */

function useUsage(rest) {
  const sessionId = useValue(host.state.activeSessionId)
  const [usage, setUsage] = useState(null)
  const [cache, setCache] = useState(null)
  const [breakdown, setBreakdown] = useState(null)
  const [loading, setLoading] = useState(false)
  const sidRef = useRef(sessionId)
  const loadRef = useRef(null)
  // runtime session id -> durable stored id, learned from gateway events
  // (session.info / session.create / … carry payload.stored_session_id).
  const storedByRuntime = useRef({})

  sidRef.current = sessionId

  const load = useCallback(async () => {
    const sid = sidRef.current
    if (!sid) {
      setUsage(null)
      setCache(null)
      setBreakdown(null)
      return
    }
    setLoading(true)
    try {
      const results = await Promise.allSettled([
        host.request('session.usage', { session_id: sid }),
        host.request('session.context_breakdown', { session_id: sid }),
      ])
      setUsage(results[0].status === 'fulfilled' ? results[0].value : null)
      setBreakdown(results[1].status === 'fulfilled' ? results[1].value : null)
    } catch (e) {
      setUsage(null)
      setBreakdown(null)
      console.error('[usage-panel] RPC failed: ' + (e && e.message))
    }
    // Persisted cache/cost rows live under the DURABLE id, not the runtime id.
    // Resolve it authoritatively via session.active_list (each live row carries
    // `session_key`, the stored id), falling back to the runtime id itself.
    let storedId = storedByRuntime.current[sid] || sid
    try {
      const act = await host.request('session.active_list', { current_session_id: sid })
      const row = (act && act.sessions || []).find(s => s.id === sid)
      if (row && row.session_key) {
        storedId = row.session_key
        storedByRuntime.current[sid] = row.session_key
      }
    } catch { /* keep storedId fallback */ }
    try {
      const data = await rest(`/usage/${encodeURIComponent(storedId)}`)
      setCache(data && data.found ? data : null)
      if (!data || !data.found) {
        console.error('[usage-panel] backend miss: runtime=' + sid + ' stored=' + storedId)
      }
    } catch (e) {
      setCache(null) // backend not mounted yet (needs one restart) — pane still works
      console.error('[usage-panel] backend failed: ' + (e && e.message))
    }
    setLoading(false)
  }, [rest])

  loadRef.current = load

  // Reload on session change.
  useEffect(() => {
    void load()
  }, [sessionId, load])

  // Events: capture the runtime->stored id mapping + refresh on relevant events.
  useEffect(() => {
    void load()
    const timer = setInterval(() => void loadRef.current(), POLL_MS)
    const off = host.onEvent('*', evt => {
      if (!evt) return
      const p = evt.payload || {}
      const rid = evt.session_id || p.session_id
      if (rid && p.stored_session_id) storedByRuntime.current[rid] = p.stored_session_id
      if (evt.type && REFRESH_EVENTS.has(evt.type)) void loadRef.current()
    })
    return () => {
      clearInterval(timer)
      if (typeof off === 'function') off()
    }
  }, [load])

  return { sessionId, usage, cache, breakdown, loading }
}

/* ── derived stats ──────────────────────────────────────────────────── */

// Tasks that are NOT the primary conversation loop — excluded from the
// "current model" headline so approval/vision/title-gen calls (often on a
// DIFFERENT cheap model) don't dilute or misrepresent the active model's
// own cache behavior. Still shown individually in the by-model breakdown.
const AUX_TASKS = new Set(['approval', 'vision', 'title_generation', 'compression'])

function sumRows(rows) {
  return rows.reduce(
    (acc, r) => ({
      input: acc.input + (r.input || 0),
      output: acc.output + (r.output || 0),
      cache_read: acc.cache_read + (r.cache_read || 0),
      cache_write: acc.cache_write + (r.cache_write || 0),
      reasoning: acc.reasoning + (r.reasoning || 0),
      calls: acc.calls + (r.calls || 0),
      est_cost_usd: acc.est_cost_usd + (r.est_cost_usd || 0),
    }),
    { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, calls: 0, est_cost_usd: 0 },
  )
}

function deriveStats(usage, cache, breakdown) {
  const models = (cache && cache.models) || []
  const liveModel = usage?.model || (cache && cache.model) || ''

  // Headline stats scope to the CURRENTLY ACTIVE model's own primary-loop
  // calls, not the whole session's lifetime aggregate — a session that
  // spent 100k calls on one model and just switched to another would
  // otherwise show a cache hit rate frozen by history, never reflecting
  // the model actually in use right now.
  const currentModelRows = liveModel
    ? models.filter(m => m.model === liveModel && !AUX_TASKS.has(m.task))
    : []
  const scoped = currentModelRows.length > 0 ? sumRows(currentModelRows) : null

  // Whole-session totals (every model/task this session has ever used) —
  // kept as a secondary "session total" figure so nothing is lost, never
  // used for the headline cache-hit number.
  const sessionPersisted = !!(cache && cache.found)
  const sessionTotals = sessionPersisted
    ? {
        input: cache.input, output: cache.output, cache_read: cache.cache_read,
        cache_write: cache.cache_write, reasoning: cache.reasoning,
        calls: cache.calls, est_cost_usd: cache.est_cost_usd,
      }
    : null

  // Prefer the current model's own scoped totals; fall back to the live RPC
  // snapshot (fresh session, nothing persisted yet); last resort: whole
  // session totals, explicitly flagged so the UI can label it as such.
  let input, output, cacheRead, cacheWrite, reasoning, calls, costUsd, scope
  if (scoped) {
    ;({ input, output, cache_read: cacheRead, cache_write: cacheWrite, reasoning, calls, est_cost_usd: costUsd } = scoped)
    scope = 'model'
  } else if (usage) {
    // Live RPC never exposes cache tokens (see skill notes) — this branch
    // only fires for a session with no persisted rows yet.
    input = usage.input ?? 0
    output = usage.output ?? 0
    cacheRead = 0
    cacheWrite = 0
    reasoning = usage.reasoning ?? 0
    calls = usage.calls ?? 0
    costUsd = usage.cost_usd ?? null
    scope = 'live'
  } else if (sessionTotals) {
    ;({ input, output, cache_read: cacheRead, cache_write: cacheWrite, reasoning, calls, est_cost_usd: costUsd } = sessionTotals)
    scope = 'session'
  } else {
    input = output = cacheRead = cacheWrite = reasoning = calls = 0
    costUsd = null
    scope = 'none'
  }

  const total = input + output + cacheRead + cacheWrite + reasoning
  // Cache hit rate = reads / all prompt-side tokens that COULD have hit —
  // i.e. reads + writes + genuine misses. `cache_write` (Anthropic's
  // cache_creation_input_tokens) is itself a MISS: fresh content that had
  // to be processed and was only written to the cache for future reuse.
  // Omitting it from the denominator is what made Claude always read as
  // ~100% — DeepSeek's API never reports cache_write>0 (its caching is
  // fully automatic/transparent, no explicit write signal), so the bug
  // was invisible until a provider with real cache-write accounting
  // (Claude, and any other Anthropic-wire model) showed up.
  const hitDenom = cacheRead + cacheWrite + input
  const hitRate = hitDenom > 0 ? cacheRead / hitDenom : null

  const sessionHitDenom = sessionTotals ? sessionTotals.cache_read + sessionTotals.cache_write + sessionTotals.input : 0
  const sessionHitRate = sessionHitDenom > 0 ? sessionTotals.cache_read / sessionHitDenom : null

  const ctx = {
    used: breakdown?.context_used ?? usage?.context_used ?? null,
    max: breakdown?.context_max ?? usage?.context_max ?? null,
    pct: breakdown?.context_percent ?? usage?.context_percent ?? null,
  }
  return {
    input, cacheRead, cacheWrite, reasoning, output, calls, total, hitRate, costUsd,
    model: liveModel, scope, models,
    sessionTotal: sessionTotals ? sessionTotals.input + sessionTotals.output + sessionTotals.cache_read + sessionTotals.cache_write + sessionTotals.reasoning : null,
    sessionHitRate,
    ctx,
  }
}

/* ── right pane ─────────────────────────────────────────────────────── */

function StatRow({ label, value }) {
  return jsxs('div', {
    style: { ...T.row, padding: '2px 0' },
    children: [
      jsx('span', { style: T.label, children: label }),
      jsx('span', { style: { ...T.strong, ...T.mono }, children: value }),
    ],
  })
}

function Bar({ pct }) {
  return jsx('div', {
    style: T.track,
    children: jsx('div', {
      style: { ...T.fill, width: `${Math.max(0, Math.min(100, pct || 0))}%` },
    }),
  })
}

function UsagePane({ rest }) {
  const t = usePluginI18n(ID)
  const { sessionId, usage, cache, breakdown, loading } = useUsage(rest)
  const s = deriveStats(usage, cache, breakdown)

  const cachePct = s.hitRate === null ? null : Math.round(s.hitRate * 100)
  const sessionCachePct = s.sessionHitRate === null ? null : Math.round(s.sessionHitRate * 100)
  const ctxPct =
    s.ctx.pct !== null && s.ctx.pct !== undefined
      ? Math.round(s.ctx.pct)
      : s.ctx.used && s.ctx.max
        ? Math.round((s.ctx.used / s.ctx.max) * 100)
        : null

  const rows = [
    [t('inputMiss'), fmt(s.input)],
    [t('cacheRead'), fmt(s.cacheRead)],
    [t('cacheWrite'), fmt(s.cacheWrite)],
    [t('output'), fmt(s.output)],
    [t('total'), fmt(s.total)],
  ]

  const scopeLabel = s.scope === 'model' ? t('scopeModel') : s.scope === 'live' ? t('scopeLive') : s.scope === 'session' ? t('scopeSession') : ''
  // Only worth showing the session-total comparison row when it actually
  // differs from the headline (i.e. headline is scoped to one model out of
  // several the session has used).
  const showSessionCompare = s.scope === 'model' && s.models.length > 1 && s.sessionTotal !== null

  return jsxs('div', {
    'data-slot': 'usage-panel',
    style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, fontSize: '0.75rem', height: '100%', overflowY: 'auto' },
    children: [
      // header
      jsxs('div', {
        style: { ...T.row },
        children: [
          jsx('span', { style: { fontWeight: 500, color: 'var(--ui-text-primary)' }, children: t('paneTitle') }),
          jsx('span', {
            style: { ...T.dim, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            children: s.model || sessionId?.slice(0, 8) || '',
          }),
        ],
      }),
      scopeLabel
        ? jsx('span', { style: { ...T.dim, fontSize: '0.625rem', marginTop: -6 }, children: scopeLabel })
        : null,
      // token rows
      jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 2 },
        children: rows.map(([label, value]) => jsx(StatRow, { label, value }, label)),
      }),
      // cache hit rate
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          jsxs('div', {
            style: { ...T.row },
            children: [
              jsx('span', { style: T.label, children: t('cacheHit') }),
              jsx('span', { style: { ...T.strong, ...T.mono }, children: cachePct === null ? '—' : `${cachePct}%` }),
            ],
          }),
          cachePct === null ? null : jsx(Bar, { pct: cachePct }),
        ],
      }),
      // session-total comparison (only shown when the headline is narrowed
      // to one model out of several — otherwise it's redundant).
      showSessionCompare
        ? jsxs('div', {
            style: { ...T.row, fontSize: '0.6875rem' },
            children: [
              jsx('span', { style: T.dim, children: t('sessionTotal') }),
              jsx('span', {
                style: { ...T.dim, ...T.mono },
                children: `${fmt(s.sessionTotal)} · ${sessionCachePct === null ? '—' : sessionCachePct + '%'}`,
              }),
            ],
          })
        : null,
      // context fill
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4 },
        children: [
          jsxs('div', {
            style: { ...T.row },
            children: [
              jsx('span', { style: T.label, children: t('context') }),
              jsx('span', {
                style: { ...T.strong, ...T.mono },
                children:
                  s.ctx.used === null || s.ctx.max === null
                    ? '—'
                    : `${fmt(s.ctx.used)} / ${fmt(s.ctx.max)}${ctxPct === null ? '' : ' · ' + ctxPct + '%'}`,
              }),
            ],
          }),
          ctxPct === null ? null : jsx(Bar, { pct: ctxPct }),
        ],
      }),
      // calls + cost
      jsxs('div', {
        style: { ...T.row },
        children: [
          jsx('span', { style: { ...T.label, ...T.mono }, children: `${t('calls')}: ${fmt(s.calls)}` }),
          jsx('span', { style: { ...T.strong, ...T.mono }, children: `${t('estCost')}: ${fmtUsd(s.costUsd)}` }),
        ],
      }),
      // model breakdown — shown whenever the backend has at least one row,
      // not gated on "more than one" (a fresh single-model session should
      // still see its own breakdown instead of the section vanishing).
      jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid var(--ui-stroke-secondary)', paddingTop: 8 },
        children: [
          jsx('span', { style: { ...T.dim, marginBottom: 2 }, children: t('perModel') }),
          ...(s.models.length
            ? s.models.map(m => {
                const isCurrent = m.model === s.model && !AUX_TASKS.has(m.task)
                const mHit = m.cache_read + m.cache_write + m.input > 0 ? Math.round((m.cache_read / (m.cache_read + m.cache_write + m.input)) * 100) : null
                return jsxs('div', {
                  style: { ...T.row },
                  children: [
                    jsx('span', {
                      style: {
                        ...(isCurrent ? T.strong : T.label),
                        maxWidth: 130,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                      children: (isCurrent ? '● ' : '') + m.model + (m.task ? ' · ' + m.task : ''),
                    }),
                    jsx('span', {
                      style: { ...T.dim, ...T.mono },
                      children: `${fmt(m.cache_read + m.input)} · ${fmt(m.output)}${mHit === null ? '' : ' · ' + mHit + '%'}`,
                    }),
                  ],
                }, m.model + ':' + (m.task || ''))
              })
            : [jsx('span', { style: T.dim, children: t('perModelEmpty') })]),
        ],
      }),
      loading
        ? jsx('span', { style: T.dim, children: t('loading') })
        : !sessionId
          ? jsx('span', { style: T.dim, children: t('noSession') })
          : null,
    ],
  })
}

/* ── statusbar chip (Kilocode-style "obvious" glance) ───────────────── */

function UsageChip({ rest }) {
  const t = usePluginI18n(ID)
  const { usage, cache, breakdown, sessionId } = useUsage(rest)
  const s = deriveStats(usage, cache, breakdown)
  const cachePct = s.hitRate === null ? null : Math.round(s.hitRate * 100)

  if (!sessionId) return null
  const label = cachePct === null ? `${fmt(s.total)}` : `${cachePct}% · ${fmt(s.total)}`

  return jsx('span', {
    title: `${t('cacheHit')}: ${cachePct === null ? '—' : cachePct + '%'} · ${t('total')}: ${fmt(s.total)}`,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '0 6px',
      fontSize: '0.6875rem',
      color: 'var(--ui-text-tertiary)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
    },
    children: label,
  })
}

/* ── plugin entry ───────────────────────────────────────────────────── */

export default {
  id: ID,
  name: 'Usage Panel',
  register(ctx) {
    ctx.i18n.register({
      en: {
        paneTitle: 'Usage',
        inputMiss: 'Input (miss)',
        cacheRead: 'Cache read',
        cacheWrite: 'Cache write',
        output: 'Output',
        total: 'Total',
        calls: 'Calls',
        estCost: 'Cost',
        cacheHit: 'Cache hit',
        context: 'Context',
        perModel: 'By model',
        perModelEmpty: 'No persisted usage yet',
        sessionTotal: 'Session total',
        scopeModel: 'Current model only',
        scopeLive: 'Live (not yet persisted)',
        scopeSession: 'Whole session (model unknown)',
        noSession: 'No active session',
        loading: 'Loading…',
      },
      zh: {
        paneTitle: '用量',
        inputMiss: '输入(未命中)',
        cacheRead: '缓存读取',
        cacheWrite: '缓存写入',
        output: '输出',
        total: '总计',
        calls: '调用',
        estCost: '成本',
        cacheHit: '缓存命中',
        context: '上下文',
        perModel: '模型明细',
        perModelEmpty: '暂无持久化用量数据',
        sessionTotal: '会话累计',
        scopeModel: '仅当前模型',
        scopeLive: '实时数据(尚未持久化)',
        scopeSession: '整个会话(模型未知)',
        noSession: '暂无活动会话',
        loading: '加载中…',
      },
    })

    // Right sidebar pane.
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Usage',
      data: { placement: 'right', width: '264px' },
      render: () => jsx(UsagePane, { rest: ctx.rest }),
    })

    // Statusbar chip: "88% · 118k" for the active session.
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 140,
      render: () => jsx(UsageChip, { rest: ctx.rest }),
    })
  },
}
