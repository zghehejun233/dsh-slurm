import test from 'node:test'
import assert from 'node:assert/strict'

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { captured = spec },
  },
}

await import('../client.js')

const stateSlots = []
const React = {
  createElement(type, props, ...children) {
    if (typeof type === 'function') return type({ ...(props ?? {}), children })
    return { type, props: props ?? {}, children }
  },
  Fragment: 'fragment',
  useState(initial) {
    const index = stateSlots.length
    if (!(index in stateSlots)) stateSlots[index] = initial
    return [stateSlots[index], (next) => { stateSlots[index] = next }]
  },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  useRef(value) { return { current: value } },
  useEffect() {},
}

function factory() {
  return captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
}

function makeCtx({ withSidebar = true } = {}) {
  const tabs = []
  const cleanups = []
  const ctx = {
    effect(fn) { const dispose = fn(); cleanups.push(dispose); return dispose },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    inject(services, callback) {
      assert.deepEqual(services, ['betterSidebar'])
      if (!withSidebar) return
      callback({
        effect(fn) { const dispose = fn(); cleanups.push(dispose); return dispose },
        betterSidebar: {
          registerTab(descriptor) { tabs.push(descriptor); return () => {} },
        },
      })
    },
  }
  return { ctx, tabs, cleanups }
}

test('client registers the Slurm tab when betterSidebar is available', () => {
  const mod = factory()
  assert.deepEqual(mod.inject, ['locale'])
  const { ctx, tabs } = makeCtx()
  mod.apply(ctx)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, 'dsh-slurm:queue')
  assert.equal(tabs[0].order, 60)
  assert.equal(tabs[0].single, true)
  assert.equal(tabs[0].title(), 'tab')
  assert.equal(typeof tabs[0].component, 'function')
  assert.equal(typeof tabs[0].icon, 'function')
})

test('client does not throw when dsh-better-sidebar is absent', () => {
  const mod = factory()
  const { ctx, tabs } = makeCtx({ withSidebar: false })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.deepEqual(tabs, [])
})


test('panel component renders its loading state without throwing', () => {
  const mod = factory()
  const { ctx, tabs } = makeCtx()
  mod.apply(ctx)
  const component = tabs[0].component
  const tree = component({ ctx, visible: false, tab: {}, scope: {} })
  assert.ok(tree)
  assert.equal(tree.type, 'div')
})
