/**
 * dsh-prompt-sharpen — 发送前体检 + 定向补全（dsh / DeepSeek Harness）
 *
 * 与「一键重写」类插件的区别只有一条：先体检，再动手。
 *   - 体检（零 token）：本地规则看草稿缺哪几项——输出格式 / 约束边界 / 验收标准 / 上下文。
 *   - 定向（一次调用）：只把缺的那几项补上，写到的部分不重复堆叠；四项齐全时反过来
 *     只做去冗余与措辞收紧，不许加戏。
 *
 * 三处入口：
 *   ✦ 输入框按钮（浏览器半身）   人用：原地替换 + 一键还原
 *   /sharpen <草稿>              人用：直接拿结果
 *   sharpen_prompt / checkup_prompt  模型用：改写、或只体检不改写
 *
 * 与其他插件一致，不 import 任何 @deepseek-ai/* 包，全部走 ctx 鸭子类型，
 * 因此以 link: 方式安装同样可用；消息对象按 dsh-llm 的 RequestUserInput
 * 形状手写（role/content/source）。
 */

export const name = 'prompt-sharpen'

/**
 * 硬依赖：少声明一个整个插件就不会激活。
 * `commands` 故意不写进 inject —— headless / acp 这类没有交互 UI 的组合根本不提供
 * 命令注册表，写进去会让插件在这些 profile 里彻底不激活。改为用 ctx.get('commands')
 * 探测：有就注册斜杠命令，没有就只保留工具。
 */
export const inject = ['llm', 'tools']

const SYSTEM_PROMPT = `你是一名提示词工程专家。用户会给你一段草稿，以及一份「体检结果」，你要在保持草稿核心目的不变的前提下，把它改写成一条更有效的提示词。

体检结果告诉你草稿缺哪些要素。改写时：
- 缺「输出格式」→ 明确结果长什么样（结构、字段、篇幅、是否要表格/代码块）。
- 缺「约束边界」→ 写出必须遵守和明确不要做的事。
- 缺「验收标准」→ 写出怎样算做完、怎样算通过。
- 缺「上下文」→ 补上让它可执行的背景（对象、现状、已有材料），但不要编造具体事实。
- 只补缺的。已经写到的不重复堆叠，不为了凑格式而加戏。
- 四项齐全时，只做去冗余与措辞收紧，不要新增任何要求。

硬性约束（违反任何一条都算失败）：
1. 语言必须与用户输入完全一致。中文进就中文出，不要中英混排，除非原文本身混排。
2. 只输出改写后的提示词本体，不要任何前言、解释、评论、标题或 Markdown 包裹。
3. 不要回答草稿里的问题，只把问题展开得更具体。
4. 不要解释「怎么做」，聚焦「要什么」。
5. 不要索取代码片段，不要推荐用户没提到的技术栈或工具。
6. 原文中的专有名词、人名地名、数字、金额、日期、文件名与路径、公司口径与限制条件，必须原样保留，不得改写或省略。
7. 不要为了变长而注水。信息量没增加就不要加句子。
8. 不要编造原文没有的事实、数据或要求。`

/** 默认上限：够一次完整改写，又不会把失控输出拉满。 */
const DEFAULTS = {
  maxOutputTokens: 1600,
  timeoutMs: 45000,
  maxInputChars: 8000,
}

const USAGE = '用法：/sharpen <要锐化的提示词>'

/**
 * 体检项。`test` 命中即视为「这一项已经写了」。
 * 规则刻意宽松——宁可漏报也不误报，误报会把按钮的红点变成狼来了。
 */
const CHECKS = [
  {
    key: 'format',
    zh: '输出格式',
    en: 'output format',
    why: '没说结果要长什么样',
    test: (text) => /(格式|表格|列表|要点|分点|条目|大纲|字数|条数|分几|json|markdown|csv|yaml|代码块|总结成|输出为|输出成|format|bullets?|table|markdown|outline)/i.test(text),
  },
  {
    key: 'constraints',
    zh: '约束边界',
    en: 'constraints',
    why: '没写必须遵守或明确不要做的事',
    test: (text) => /(不要|不许|别把|禁止|必须|务必|只能|仅限|至少|最多|不超过|不少于|限制|避免|保留原|不作假|don'?t|do not|must|never|only|at least|at most|no more than|avoid|without|keep)/i.test(text),
  },
  {
    key: 'acceptance',
    zh: '验收标准',
    en: 'acceptance criteria',
    why: '没说怎样算做完、怎样算通过',
    test: (text) => /(验收|通过标准|完成标准|算完成|算做完|证明|证据|可验证|跑通|测试通过|检查项|done when|acceptance|evidence|verify|verifies|criteria|test passes|green)/i.test(text),
  },
  {
    key: 'context',
    zh: '上下文',
    en: 'context',
    why: '没给可执行的背景、对象或已有材料',
    test: (text) => text.length >= 240
      || /(路径|文件|目录|代码|仓库|项目|报错|错误|日志|截图|背景|现状|当前|以下|如下|附件|数据|文档|材料|path|file|dir|repo|project|error|log|screenshot|context|given|below|attached)/i.test(text),
  },
]

/** 少于这个长度就不体检——太短的草稿全身都是缺口，说了也没用。 */
const MIN_CHECKABLE = 12

/**
 * 体检草稿：返回缺哪几项，不调用模型、不花 token。
 * @param {string} input - 草稿。
 * @returns {{state: string, total: number, score: number, missing: Array, satisfied: Array}}
 */
function inspectDraft(input) {
  const body = String(input ?? '').trim()
  if (body.length < MIN_CHECKABLE) {
    return { state: 'too-short', total: CHECKS.length, score: 0, missing: [], satisfied: [] }
  }
  const missing = []
  const satisfied = []
  for (const check of CHECKS) {
    let hit = false
    try {
      hit = Boolean(check.test(body))
    } catch {
      hit = false
    }
    const entry = { key: check.key, zh: check.zh, en: check.en }
    if (hit) satisfied.push(entry)
    else missing.push({ ...entry, why: check.why })
  }
  return { state: 'ok', total: CHECKS.length, score: satisfied.length, missing, satisfied }
}

/**
 * 把体检结果写成给模型看的一段提示，附在草稿后面。
 * @param {object} report - inspectDraft 的结果。
 * @returns {string} 空字符串表示不需要附加。
 */
function checkHint(report) {
  if (!report || report.state !== 'ok') return ''
  if (report.missing.length === 0) {
    return '【体检结果】四项要素齐全。只做去冗余与措辞收紧，不要新增任何要求。'
  }
  const labels = report.missing.map((item) => item.zh).join('、')
  return `【体检结果】这条草稿缺少：${labels}。改写时优先把缺的补上；已经写到的部分不要重复堆叠。`
}

/**
 * 解析本次调用用的模型路由。
 * 优先级：插件配置 > 调用方 agent 正在用的路由 > 组合里的默认模型。
 * HTTP 路由没有 agent 可问，所以最后一档（agentDefaultModel）是给界面按钮用的。
 * @param {object} config - 插件配置。
 * @param {object} [agent] - 调用方 agent（命令与工具都会给）。
 * @param {object} [ctx] - 用来查默认模型服务的上下文。
 * @returns {{provider: string, model: string, reasoningEffort?: string}}
 */
function resolveRoute(config, agent, ctx) {
  if (config?.provider && config?.model) {
    return { provider: String(config.provider), model: String(config.model) }
  }
  if (agent?.options?.provider && agent?.options?.model) {
    return { provider: String(agent.options.provider), model: String(agent.options.model) }
  }
  const fallback = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
  if (fallback?.provider && fallback?.model) {
    return {
      provider: String(fallback.provider),
      model: String(fallback.model),
      ...(fallback.reasoningEffort ? { reasoningEffort: fallback.reasoningEffort } : {}),
    }
  }
  throw new Error('无法确定模型路由：请设置插件 config.provider / config.model')
}

/** 手写一条 one-shot 用户消息，形状与 dsh-llm 的 RequestUserInput 一致。 */
function userMessage(text) {
  return {
    id: `sharpen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 发一次辅助模型调用，把流式文本拼成完整结果。
 * @param {object} ctx - 带 llm 服务的上下文。
 * @param {object} options - 配置、路由、输入、体检结果、取消信号。
 * @returns {Promise<string>} 锐化后的提示词。
 */
async function sharpen(ctx, options) {
  const { config = {}, route, input, report, signal } = options
  const maxInputChars = Number(config.maxInputChars) || DEFAULTS.maxInputChars
  const text = String(input ?? '').trim()
  if (!text) throw new Error('输入为空')
  if (text.length > maxInputChars) {
    throw new Error(`输入 ${text.length} 字，超过上限 ${maxInputChars} 字（可调 config.maxInputChars）`)
  }

  const timeoutMs = Number(config.timeoutMs) || DEFAULTS.timeoutMs
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline

  const hint = checkHint(report)
  const payload = hint ? `${text}\n\n${hint}` : text

  let output = ''
  let failure
  const request = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    system: SYSTEM_PROMPT,
    messages: [userMessage(payload)],
    maxTokens: Number(config.maxOutputTokens) || DEFAULTS.maxOutputTokens,
    signal: combined,
  }

  for await (const chunk of ctx.llm.stream(request)) {
    if (chunk?.type === 'text-delta') output += chunk.text
    else if (chunk?.type === 'finish') {
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
        failure = chunk.reason.failure?.message || chunk.reason.kind
      }
    }
  }

  if (failure) throw new Error(failure)
  if (combined.aborted) throw new Error(`锐化超时或被取消（${timeoutMs}ms）`)
  const result = output.trim()
  if (!result) throw new Error('模型没有返回文本')
  return result
}

/** 命令与工具共用的失败文案：把底层错误收敛成一句人话。 */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return `锐化失败：${message}`
}

/** 把体检结果压成一行，给 checkup_prompt 工具和 /checkup 用。 */
function formatReport(report) {
  if (!report || report.state === 'too-short') {
    return `草稿太短（少于 ${MIN_CHECKABLE} 字），暂时看不出缺口。`
  }
  if (report.missing.length === 0) {
    return `四项要素齐全（${report.score}/${report.total}）：输出格式、约束边界、验收标准、上下文都写了。`
  }
  const lines = report.missing.map((item) => `- ${item.zh}：${item.why}`)
  return `体检 ${report.score}/${report.total}，缺少 ${report.missing.length} 项：\n${lines.join('\n')}`
}

/**
 * 注册 /sharpen 与两个工具。
 * @param {object} ctx - 注入后的上下文。
 * @param {object} [config] - 插件配置（provider/model/limits）。
 */
export function apply(ctx, config = {}) {
  const commands = ctx.get('commands')
  if (commands) {
    commands.register({
      name: 'sharpen',
      description: '先体检草稿缺什么，再定向补全成更有效的提示词（一次辅助模型调用，不进入对话）',
      input: { hint: '<草稿>' },
      handler: async (invocation) => {
        const draft = String(invocation?.rawInput ?? '').trim()
        if (!draft) return { kind: 'error', text: USAGE }
        try {
          const text = await sharpen(ctx, {
            config,
            route: resolveRoute(config, invocation?.agent, ctx),
            input: draft,
            report: inspectDraft(draft),
            signal: invocation?.signal,
          })
          return { kind: 'success', text }
        } catch (error) {
          return { kind: 'error', text: describeError(error) }
        }
      },
    })
  }

  ctx.tools.register({
    name: 'sharpen_prompt',
    description:
      'Tighten a rough prompt: diagnose what it is missing (output format, constraints, acceptance criteria, context) '
      + 'and fill exactly those gaps while keeping the original goal. Use when the user asks to improve or optimize a prompt.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The draft prompt to tighten.' },
        constraints: {
          type: 'string',
          description: 'Optional extra requirements for the rewrite (tone, length, output format).',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const prompt = String(args?.prompt ?? '').trim()
      if (!prompt) throw new Error('prompt 不能为空')
      const constraints = String(args?.constraints ?? '').trim()
      const input = constraints ? `${prompt}\n\n【额外要求】${constraints}` : prompt
      return sharpen(ctx, {
        config,
        route: resolveRoute(config, exec?.agent, ctx),
        input,
        report: inspectDraft(input),
        signal: exec?.signal,
      })
    },
  })

  ctx.tools.register({
    name: 'checkup_prompt',
    description:
      'Diagnose a prompt draft without spending tokens: report which of output format, constraints, acceptance criteria '
      + 'and context are missing. Use before sending a complex request, or when the user asks what their prompt lacks.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The draft prompt to diagnose.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const prompt = String(args?.prompt ?? '')
      return formatReport(inspectDraft(prompt))
    },
  })

  // ── 界面上那个按钮用的接口 ────────────────────────────────────────────────
  // 浏览器半身（client.js）在输入框工具条放一个按钮：草稿一变就打 /check 拿红点，
  // 点一下再打 /enhance 拿结果写回编辑器。webServer 可能晚于插件发布，所以必须用
  // ctx.inject 等它出现——apply 里直接 ctx.get('webServer') 会拿到 undefined。
  if (config?.uiButton !== false) {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(
        () => scoped.webServer.register({
          kind: 'exact',
          path: CHECK_PATH,
          handler: (req, res) => handleCheckRequest(ctx, config, req, res),
        }),
        'prompt-sharpen: check route',
      )
      scoped.effect(
        () => scoped.webServer.register({
          kind: 'exact',
          path: ENHANCE_PATH,
          handler: (req, res) => handleEnhanceRequest(ctx, config, req, res),
        }),
        'prompt-sharpen: enhance route',
      )
    })
  }
}

/** 界面按钮调用的路由。前缀比内核的 /api 长，因此会先于内核鉴权命中。 */
const CHECK_PATH = '/api/prompt-sharpen/check'
const ENHANCE_PATH = '/api/prompt-sharpen/enhance'

/** 请求体上限：一份草稿不该有 1MB。 */
const MAX_BODY_BYTES = 1 << 20

/**
 * 结构化的同源围栏（组合里没有 connection 服务时的退路）：
 * 只接受本机回环来源，且跨站请求一律拒绝。
 * @param {object} req - Node 请求对象。
 * @returns {number|undefined} 拒绝时的状态码。
 */
function structuralRejection(req) {
  const address = String(req?.socket?.remoteAddress ?? '')
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return 403
  const origin = req?.headers?.origin
  const host = req?.headers?.host
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

/**
 * 沿用组合自己的准入判断；没有 connection 服务时退回结构化围栏。
 * @param {object} req - Node 请求对象。
 * @param {object} ctx - 上下文，用来取 connection 服务。
 * @returns {number|undefined} 拒绝时的状态码。
 */
function admissionRejection(req, ctx) {
  const connection = ctx.get('connection')
  if (connection) {
    const decide = typeof connection.admit === 'function'
      ? connection.admit
      : typeof connection.requestRejection === 'function' ? connection.requestRejection : undefined
    if (typeof decide === 'function') {
      try {
        const outcome = decide.call(connection, req)
        if (typeof outcome === 'number') return outcome
        if (outcome && typeof outcome.rejection === 'number') return outcome.rejection
        return undefined
      } catch {
        return 503
      }
    }
  }
  return structuralRejection(req)
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 读完整个请求体并解析成 JSON；超限或格式错误直接抛。
 * @param {object} req - Node 请求对象。
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 两个界面路由共用的前半段：鉴权、方法、读体。
 * @returns {Promise<{rejected: boolean, payload?: object}>}
 */
async function intake(ctx, req, res) {
  const rejection = admissionRejection(req, ctx)
  if (rejection !== undefined) {
    sendJson(res, rejection, { ok: false, error: 'unauthorized' })
    return { rejected: true }
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return { rejected: true }
  }
  try {
    return { rejected: false, payload: await readJsonBody(req) }
  } catch (error) {
    sendJson(res, 400, { ok: false, error: describeError(error) })
    return { rejected: true }
  }
}

/**
 * POST /api/prompt-sharpen/check — 零 token 体检，按钮靠它决定要不要亮红点。
 */
async function handleCheckRequest(ctx, config, req, res) {
  const intakeResult = await intake(ctx, req, res)
  if (intakeResult.rejected) return
  const draft = String(intakeResult.payload?.draft ?? '')
  sendJson(res, 200, { ok: true, ...inspectDraft(draft) })
}

/**
 * POST /api/prompt-sharpen/enhance — 按钮的唯一入口。
 * 业务失败也返回 200 + ok:false，让按钮把原因显示成提示，而不是当成网络错误。
 * 返回 added：这次实际补上了哪几项，供按钮做「已补：输出格式」的回执。
 */
async function handleEnhanceRequest(ctx, config, req, res) {
  const intakeResult = await intake(ctx, req, res)
  if (intakeResult.rejected) return
  const draft = String(intakeResult.payload?.draft ?? '').trim()
  if (!draft) {
    sendJson(res, 400, { ok: false, error: '草稿为空' })
    return
  }
  const before = inspectDraft(draft)
  try {
    const text = await sharpen(ctx, {
      config,
      route: resolveRoute(config, undefined, ctx),
      input: draft,
      report: before,
    })
    const after = inspectDraft(text)
    const fixed = new Set(after.satisfied.map((item) => item.key))
    const added = before.missing
      .filter((item) => fixed.has(item.key))
      .map((item) => ({ key: item.key, zh: item.zh, en: item.en }))
    sendJson(res, 200, { ok: true, text, added, before: { score: before.score, total: before.total }, after: { score: after.score, total: after.total } })
  } catch (error) {
    sendJson(res, 200, { ok: false, error: describeError(error) })
  }
}
