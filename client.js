/**
 * dsh-prompt-sharpen — 浏览器半身（输入框工具条上的「体检 / 锐化」按钮）。
 *
 * 手写 ModuleLoader 包：无构建步骤，除 shell 自带的 react 外无依赖。
 * 挂载点：conversation.input.left —— 输入框工具行左侧的列表槽位，
 * 也就是权限选择器与模型选择器之间的那块空白。
 *
 * 数据通路：
 *   草稿变化 → debounce 450ms → POST /api/prompt-sharpen/check → 缺口红点
 *   点按钮   → POST /api/prompt-sharpen/enhance → 写回草稿（inputActions.setDraft）
 *   再点一次 → 还原原文
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-sharpen',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const inject = ['slots']
    const CHECK_ENDPOINT = '/api/prompt-sharpen/check'
    const ENHANCE_ENDPOINT = '/api/prompt-sharpen/enhance'

    /** 与服务端一致的「太短不体检」门线。 */
    const MIN_CHECKABLE = 12

    /**
     * 把体检报告压成缺口标签列表；报告缺失或太短时返回空数组。
     * @param {object|null} report - 服务端 /check 的返回。
     * @returns {string[]}
     */
    function gapLabels(report) {
      if (!report || report.state !== 'ok' || !Array.isArray(report.missing)) return []
      return report.missing.map(item => (item && item.zh) || '').filter(Boolean)
    }

    /** 图形：星芒（锐化）/ 回退箭头（还原原文）/ 感叹号（失败）。 */
    function Glyph({ revert, failed }) {
      if (revert) {
        return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('path', {
            d: 'M4 6h5.5a3.5 3.5 0 1 1 0 7H6',
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
          h('path', {
            d: 'M5.8 3.8 3.6 6l2.2 2.2',
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
        )
      }
      if (failed) {
        return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.4 }),
          h('path', { d: 'M8 5v4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
          h('circle', { cx: 8, cy: 11.1, r: 0.85, fill: 'currentColor' }),
        )
      }
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 1.8l1.35 3.55L13 6.7l-3.65 1.35L8 11.6 6.65 8.05 3 6.7l3.65-1.35z',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12.4 10.6l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45L10.4 13l1.45-.55z',
          fill: 'currentColor',
        }),
      )
    }

    /** 转圈：SMIL 动画，不依赖外部样式表。 */
    function Spinner() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('circle', {
          cx: 8, cy: 8, r: 5.6, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.6, strokeOpacity: 0.25,
        }),
        h('path', {
          d: 'M8 2.4a5.6 5.6 0 0 1 5.6 5.6', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        },
          h('animateTransform', {
            attributeName: 'transform', type: 'rotate',
            from: '0 8 8', to: '360 8 8', dur: '0.9s', repeatCount: 'indefinite',
          }),
        ),
      )
    }

    /** 缺口红点：右上角一个小圆，告诉用户「这份草稿还缺点东西」。 */
    function GapDot() {
      return h('span', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          top: 4,
          right: 4,
          width: 6,
          height: 6,
          borderRadius: 3,
          background: '#ff6b6b',
          boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.18)',
          pointerEvents: 'none',
        },
      })
    }

    /**
     * 输入框工具行上的按钮。props 由槽位注入：useInput 给草稿，
     * inputActions 给写回能力（setDraft 会替换整份草稿并保留撤销步）。
     */
    function SharpenButton(props) {
      const draft = props.useInput(state => state.draft)
      const actions = props.inputActions
      const [busy, setBusy] = useState(false)
      const [hover, setHover] = useState(false)
      const [error, setError] = useState('')
      const [pair, setPair] = useState(null) // { original, enhanced }
      const [report, setReport] = useState(null) // 体检结果
      const [fixed, setFixed] = useState('') // 「已补：输出格式」

      const text = typeof draft === 'string' ? draft : ''

      // 草稿一变就重新体检；零 token，但要防抖，别每个按键都打一次。
      useEffect(() => {
        const body = text.trim()
        if (body.length < MIN_CHECKABLE) {
          setReport(null)
          return undefined
        }
        let cancelled = false
        const timer = setTimeout(() => {
          fetch(CHECK_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ draft: body }),
          }).then(response => (response.ok ? response.json() : null))
            .then(payload => {
              if (!cancelled && payload && payload.ok === true) setReport(payload)
            })
            .catch(() => { /* 体检失败不打扰用户，按钮照常可用 */ })
        }, 450)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [text])

      const revertable = pair !== null && text === pair.enhanced && !busy
      const disabled = busy || (!revertable && text.trim().length === 0)
      const gaps = gapLabels(report)
      const showGap = gaps.length > 0 && !revertable && !busy && !error

      const onClick = useCallback(async () => {
        if (busy || !actions) return
        if (revertable) {
          actions.setDraft(pair.original)
          setPair(null)
          setFixed('')
          setError('')
          return
        }
        const original = text
        setBusy(true)
        setError('')
        setFixed('')
        try {
          const response = await fetch(ENHANCE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ draft: original }),
          })
          if (!response.ok) {
            throw new Error(response.status === 401 ? '鉴权失败，刷新页面后重试' : `HTTP ${response.status}`)
          }
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error || '锐化失败')
          actions.setDraft(payload.text)
          setPair({ original, enhanced: payload.text })
          const filled = Array.isArray(payload.added) ? payload.added.map(item => item.zh) : []
          setFixed(filled.join('、'))
          setReport(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [busy, revertable, pair, text, actions])

      const title = error
        ? `锐化失败：${error}`
        : revertable
          ? (fixed ? `已补：${fixed}；点一下还原原文` : '已增强；点一下还原原文')
          : busy
            ? '正在补缺口…'
            : text.trim().length === 0
              ? '先写点东西'
              : gaps.length > 0
                ? `缺：${gaps.join('、')}（点一下补上）`
                : '锐化提示词'

      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        'aria-busy': busy || undefined,
        disabled,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          padding: 0,
          border: 'none',
          borderRadius: 8,
          background: hover && !disabled ? 'rgba(127, 127, 127, 0.14)' : 'transparent',
          color: 'inherit',
          opacity: disabled ? 0.35 : hover ? 1 : 0.72,
          cursor: disabled ? 'default' : 'pointer',
          transition: 'background-color 120ms ease, opacity 120ms ease',
          flex: '0 0 auto',
        },
      },
        busy ? h(Spinner) : h(Glyph, { revert: revertable, failed: Boolean(error) }),
        showGap ? h(GapDot) : null,
      )
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'prompt-sharpen',
        order: 50,
        label: '锐化提示词',
      }, SharpenButton))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'prompt-sharpen'
    /** 给冒烟测试用的纯函数出口（运行时不会有人读它）。 */
    exports.__internals = { gapLabels, MIN_CHECKABLE }
    return module.exports
  },
})
