# dsh-prompt-sharpen

Pre-send checkup for prompts in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Most "enhance prompt" buttons rewrite whatever you typed. This one reads it first: a **zero-token lint** in the composer tells you which of four things your draft is still missing, and one click fills **exactly those gaps** — no padding, no invented requirements. The original stays one click away.

## What it checks

| Gap | Looking for |
| --- | --- |
| Output format | result shape: structure, fields, length, table / code block |
| Constraints | what must hold, what must not be done |
| Acceptance criteria | how you will know it is done or correct |
| Context | the background, inputs or materials that make it executable |

The lint is local, rule-based and free: it never calls a model. A red dot on the button appears only when a gap is found, and the tooltip names the gaps (`缺：输出格式、验收标准`). A draft shorter than 12 characters is not checked — at that size everything is missing and the answer is noise.

## Directed, not generic

When you press the button, the gaps are passed to the model as a `【体检结果】` block:

- Missing items → fill those, and do not restate what is already written.
- All four present → strip redundancy and tighten wording, and **add nothing**.

The rewrite replaces the draft in place. The button turns into a revert arrow; one click restores the exact original text. A request that fails (bad route, timeout, empty completion) never touches your draft — the button just shows the reason.

## Three ways in

| Surface | What it does |
| --- | --- |
| Composer button (left of the model selector) | check the draft, then sharpen it in place |
| `/sharpen <draft>` | same pipeline from the command line |
| `sharpen_prompt` tool | lets the agent tighten a prompt the user is drafting |
| `checkup_prompt` tool | diagnose only — no model call, no tokens |

HTTP, for the UI half: `POST /api/prompt-sharpen/check` and `POST /api/prompt-sharpen/enhance`, both taking `{ "draft": "…" }` and restricted to loopback, same-origin requests.

## Install

Desktop app: open **Plugins**, search `dsh-prompt-sharpen`, install, then restart — client bundles are composed at startup.

Command line, for a `web` profile:

```bash
dsh plugin --profile web add dsh-prompt-sharpen
```

The package declares `dsh.bundle.patch` and ships `cordis.patch.yml`, so it loads as a bundle without hand-editing the profile.

## Configuration

```yaml
- id: dsh-prompt-sharpen
  name: dsh-prompt-sharpen
  config:
    provider: deepseek-account   # default: the calling agent's route,
    model: deepseek-flash        #          then the composition default model
    maxOutputTokens: 1600
    timeoutMs: 45000
    maxInputChars: 8000
    uiButton: true               # false: keep the command and tools, drop the button
```

## Notes

- Zero runtime dependencies. Both halves are plain ESM/CJS and only touch `ctx` services, so `link:` installs work too.
- The button never sends your message. You always read the result before pressing Enter.
- Only the draft you press the button on is sent, to the model route you configured. No telemetry, no storage.
- Client bundle lives at `client.js`; host half at `index.js`; both are small enough to read in one sitting.

## License

MIT
