# dsh-prompt-sharpen

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的输入框里做**发送前体检**。

大多数「增强提示词」按钮是不管你写了什么，统统重写一遍。这个是先看再动手：输入框里一个**零 token 的体检**告诉你草稿还差哪几项，点一下**只补缺的那几项**——不注水、不加你没提的要求，原文再点一下就能拿回来。

## 体检什么

| 缺口 | 看的是 |
| --- | --- |
| 输出格式 | 结果长什么样：结构、字段、篇幅、是否表格/代码块 |
| 约束边界 | 必须遵守什么、明确不要做什么 |
| 验收标准 | 怎样算做完、怎样算通过 |
| 上下文 | 让它可执行的背景、对象、已有材料 |

体检是本地规则，不花 token、不调模型。只有真的查出缺口，按钮右上角才亮红点，悬停提示直接写出来（`缺：输出格式、验收标准`）。草稿短于 12 个字不体检——那个长度上什么都缺，说了也是噪音。

## 定向，而不是通用重写

按按钮时，体检结论会以 `【体检结果】` 的形式交给模型：

- 有缺口 → 优先补这些，已经写到的部分不重复堆叠。
- 四项齐全 → 只去冗余、收紧措辞，**不许新增要求**。

结果原地替换草稿，按钮变成还原箭头，一键回到完全一样的原文。调用失败（路由不通、超时、空回包）绝不碰你的草稿，只在按钮上把原因显示出来。

## 四个入口

| 位置 | 作用 |
| --- | --- |
| 输入框工具条（模型选择器左侧） | 体检 + 原地锐化 |
| `/sharpen <草稿>` | 命令行同一套流程 |
| `sharpen_prompt` 工具 | 让 agent 帮用户收紧正在起草的提示词 |
| `checkup_prompt` 工具 | 只体检，不调模型、不花 token |

界面用的 HTTP 接口：`POST /api/prompt-sharpen/check`、`POST /api/prompt-sharpen/enhance`，都吃 `{ "draft": "…" }`，只接受本机回环的同源请求。

## 安装

桌面端：打开发送框上方的**插件**页，搜 `dsh-prompt-sharpen` 安装，然后**完全退出再打开**——client bundle 是启动时拼进去的。

命令行，装进 `web` profile：

```bash
dsh plugin --profile web add dsh-prompt-sharpen
```

包声明了 `dsh.bundle.patch` 并自带 `cordis.patch.yml`，所以按 bundle 直接挂载，不用手改 profile。

## 配置

```yaml
- id: dsh-prompt-sharpen
  name: dsh-prompt-sharpen
  config:
    provider: deepseek-account   # 默认用调用方 agent 的路由，
    model: deepseek-flash        # 再退到组合的默认模型
    maxOutputTokens: 1600
    timeoutMs: 45000
    maxInputChars: 8000
    uiButton: true               # 关掉后只保留命令与工具，不挂按钮
```

## 说明

- 零运行时依赖。两个半身都是手写 ESM/CJS，只碰 `ctx` 上的服务，所以 `link:` 方式安装同样可用。
- 按钮永远不会替你发送消息。结果你自己看过再按回车。
- 只有你按下按钮的那份草稿会被送到你配置的模型路由。没有遥测，不落盘。
- 宿主半身 `index.js`，浏览器半身 `client.js`，两份都短到能一次读完。

## 许可证

MIT
