/**
 * dsh-prompt-sharpen 冒烟测试：不需要启动 DSH，用假的 ctx 把两个半身都跑一遍。
 *   node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { apply, name, inject } from '../index.js'

const results = []
async function check(label, fn) {
  try {
    await fn()
    results.push(`  ok   ${label}`)
  } catch (error) {
    results.push(`  FAIL ${label}\n       ${error.message}`)
    process.exitCode = 1
  }
}

/** 假请求：把 JSON 当请求体喂进去。 */
function fakeRequest({ method = 'POST', body, origin, host = '127.0.0.1:53993', remote = '127.0.0.1' } = {}) {
  return {
    method,
    headers: { host, ...(origin ? { origin } : {}) },
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}

/** 假响应：记下状态码与 JSON。 */
function fakeResponse() {
  const captured = { status: 0, body: null }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(chunk) {
      if (chunk) captured.body = JSON.parse(String(chunk))
    },
  }
}

const routes = new Map()
const registered = { commands: [], tools: [] }
const prompts = []

const ctx = {
  get(service) {
    if (service === 'commands') return { register: spec => registered.commands.push(spec) }
    if (service === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
    }
    return undefined
  },
  tools: { register: spec => registered.tools.push(spec) },
  llm: {
    async *stream(request) {
      prompts.push(request.messages[0].content[0].text)
      yield { type: 'text-delta', text: '按 json 输出，不要改文件，' }
      yield { type: 'text-delta', text: '验收标准是表格能直接贴进周报' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  inject(services, fn) {
    assert.deepEqual(services, ['webServer'])
    fn({
      webServer: {
        register(route) {
          routes.set(route.path, route.handler)
          return () => routes.delete(route.path)
        },
      },
      effect(fn) { fn() },
    })
  },
}

apply(ctx, {})

await check('插件名与硬依赖', () => {
  assert.equal(name, 'prompt-sharpen')
  assert.deepEqual(inject, ['llm', 'tools'])
})

await check('注册了 /sharpen 命令', () => {
  assert.equal(registered.commands.length, 1)
  assert.equal(registered.commands[0].name, 'sharpen')
  assert.equal(typeof registered.commands[0].handler, 'function')
})

await check('注册了两个工具', () => {
  const names = registered.tools.map(tool => tool.name).sort()
  assert.deepEqual(names, ['checkup_prompt', 'sharpen_prompt'])
  for (const tool of registered.tools) {
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 render`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`)
  }
})

await check('两条界面路由都挂上了', () => {
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/prompt-sharpen/check',
    '/api/prompt-sharpen/enhance',
  ])
})

// ── 体检（零 token） ────────────────────────────────────────────────────────
async function callCheck(draft) {
  const res = fakeResponse()
  await routes.get('/api/prompt-sharpen/check')(fakeRequest({ body: { draft } }), res)
  return res.captured
}

async function callEnhance(draft) {
  const res = fakeResponse()
  await routes.get('/api/prompt-sharpen/enhance')(fakeRequest({ body: { draft } }), res)
  return res.captured
}

const vague = '帮我把这份销售数据分析一下，然后给我一些结论和建议，最好能直接用在周会上'
const complete = '读 C:/dsh/workspace/sales.csv 这个文件，按 markdown 表格输出每个区域的环比，'
  + '不要修改任何文件，保留原有小数位。验收标准：表格能直接贴进周报且数字与源文件一致。'

const vagueResult = await callCheck(vague)
await check('模糊草稿会报缺口', () => {
  assert.equal(vagueResult.status, 200)
  assert.equal(vagueResult.body.ok, true)
  assert.equal(vagueResult.body.state, 'ok')
  const missing = vagueResult.body.missing.map(item => item.key).sort()
  assert.ok(missing.includes('format'), `应缺格式，实际缺 ${missing}`)
  assert.ok(missing.includes('acceptance'), `应缺验收，实际缺 ${missing}`)
})

const completeResult = await callCheck(complete)
await check('完整草稿不报缺口', () => {
  assert.equal(completeResult.body.ok, true)
  assert.equal(completeResult.body.missing.length, 0, JSON.stringify(completeResult.body.missing))
  assert.equal(completeResult.body.score, 4)
})

const shortResult = await callCheck('写个周报')
await check('太短的草稿不体检', () => {
  assert.equal(shortResult.body.state, 'too-short')
  assert.equal(shortResult.body.missing.length, 0)
})

// ── 锐化（带体检结论） ─────────────────────────────────────────────────────
const enhanced = await callEnhance(vague)
await check('增强结果写回并回执补了哪几项', () => {
  assert.equal(enhanced.status, 200)
  assert.equal(enhanced.body.ok, true)
  assert.ok(Array.isArray(enhanced.body.added))
  assert.ok(enhanced.body.added.length >= 1, '至少应回执一项')
  assert.equal(enhanced.body.before.total, 4)
  assert.equal(enhanced.body.after.total, 4)
})

await check('提示词里带上了体检结论', () => {
  const last = prompts.at(-1)
  assert.match(last, /【体检结果】/)
  assert.match(last, /缺少/)
  assert.ok(last.includes(vague))
})

await check('齐全的草稿要求只做去冗余', async () => {
  const res = await callEnhance(complete)
  assert.equal(res.body.ok, true)
  assert.match(prompts.at(-1), /四项要素齐全/)
})

// ── 围栏 ───────────────────────────────────────────────────────────────────
await check('跨站来源被拒', async () => {
  const res = fakeResponse()
  await routes.get('/api/prompt-sharpen/enhance')(
    fakeRequest({ body: { draft: 'x' }, origin: 'https://evil.example' }),
    res,
  )
  assert.equal(res.captured.status, 403)
})

await check('非 POST 被拒', async () => {
  const res = fakeResponse()
  await routes.get('/api/prompt-sharpen/enhance')(fakeRequest({ method: 'GET' }), res)
  assert.equal(res.captured.status, 405)
})

await check('空草稿 400', async () => {
  const res = fakeResponse()
  await routes.get('/api/prompt-sharpen/enhance')(fakeRequest({ body: { draft: '  ' } }), res)
  assert.equal(res.captured.status, 400)
})

// ── 工具 ───────────────────────────────────────────────────────────────────
await check('checkup_prompt 只体检不调模型', async () => {
  const before = prompts.length
  const tool = registered.tools.find(item => item.name === 'checkup_prompt')
  const text = await tool.execute({ prompt: vague }, {})
  assert.equal(prompts.length, before, '不应触发模型调用')
  assert.match(text, /缺少/)
})

await check('sharpen_prompt 支持附加约束', async () => {
  const tool = registered.tools.find(item => item.name === 'sharpen_prompt')
  await tool.execute({ prompt: vague, constraints: '用简体中文' }, {})
  assert.match(prompts.at(-1), /【额外要求】用简体中文/)
})

await check('/sharpen 命令空输入给用法', async () => {
  const result = await registered.commands[0].handler({ rawInput: '   ', agent: {} })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法/)
})

await check('/sharpen 命令正常出结果', async () => {
  const result = await registered.commands[0].handler({ rawInput: vague, agent: {} })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /json/)
})

// ── 浏览器半身 ─────────────────────────────────────────────────────────────
let clientModule
const loaded = []

await check('client.js 能被 ModuleLoader 载入且只依赖 react', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const ReactShim = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
  }
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec)
        clientModule = spec.factory(id => {
          if (id !== 'react') throw new Error(`意外的依赖 ${id}`)
          return ReactShim
        })
      },
    },
  }
  const run = new Function('window', `${source}`)
  run(fakeWindow)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-prompt-sharpen')
})

await check('客户端注册到 conversation.input.left', () => {
  assert.equal(typeof clientModule.apply, 'function')
  assert.deepEqual(clientModule.inject, ['slots'])
  let entry = null
  clientModule.apply({
    slots: {
      inject(slot, fn) {
        assert.equal(slot, 'conversation.input.left')
        fn()
      },
      register(options, component) { entry = { options, component } },
    },
  })
  assert.equal(entry.options.id, 'prompt-sharpen')
  assert.equal(entry.options.order, 50)
  assert.equal(entry.options.name, 'conversation.input.left')
  assert.equal(typeof entry.component, 'function')
})

await check('按钮渲染：有草稿时出星芒，title 走缺口文案', () => {
  const { component } = (() => {
    let entry = null
    clientModule.apply({
      slots: { inject: (slot, fn) => fn(), register: (options, comp) => { entry = { options, component: comp } } },
    })
    return entry
  })()
  const element = component({
    useInput: selector => selector({ draft: '帮我把这份销售数据分析一下然后给建议' }),
    inputActions: { setDraft() {} },
  })
  assert.equal(element.type, 'button')
  assert.equal(element.props.type, 'button')
  assert.equal(typeof element.props.title, 'string')
  assert.ok(element.props.title.length > 0)
  // 空草稿时按钮被禁用
  const empty = component({
    useInput: selector => selector({ draft: '' }),
    inputActions: { setDraft() {} },
  })
  assert.equal(empty.props.disabled, true)
})

await check('缺口文案来自报告的 missing 列表', () => {
  const internals = clientModule.__internals
  assert.equal(typeof internals.gapLabels, 'function')
  assert.deepEqual(
    internals.gapLabels({ state: 'ok', missing: [{ zh: '输出格式' }, { zh: '验收标准' }] }),
    ['输出格式', '验收标准'],
  )
  assert.deepEqual(internals.gapLabels({ state: 'too-short', missing: [] }), [])
  assert.deepEqual(internals.gapLabels(null), [])
  assert.equal(internals.MIN_CHECKABLE, 12)
})

console.log(`\ndsh-prompt-sharpen 冒烟测试\n${results.join('\n')}\n`)
console.log(process.exitCode ? '有失败项，见上。' : '全部通过。')
