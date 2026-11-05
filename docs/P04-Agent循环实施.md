# P04 Agent 循环实施与 P05 接口

日期：2026-11-03。P04 已完成独立循环核心、真实 SDK 适配及离线验证。实际小说检索、数据库记录、运行队列、HTTP/SSE、聊天与候选应用在 P05 接入；本阶段没有数据库迁移，schemaVersion 仍为 3。

## 入口与边界

`packages/agent/src/index.ts` 导出 `runLoop`、`FakeModelAdapter`、`PiModelAdapter`、`ActionRegistry`、`MemoryLoopRecorder`、用量汇总及接口类型。agent 只依赖 shared 与 pi-ai，不导入 server、数据库、HTTP 框架或前端。SDK 导入仅位于 `src/model/`，由 AST 边界检查及浏览器产物检查约束；没有使用现成 Agent loop。

`runLoop(input)` 接收 runId、adapter、registry、request、recorder、AbortSignal，以及可选 checkpoint、initialSeq 和 clock。输入及检查点错误在任何记录/供应商调用前抛出；运行中的失败返回 `LoopResult`。`turns` 为本次完整提交轮数，`attemptedTurns` 为本次已开始模型调用数；`output.committed` 区分暂存显示与完整轮次输出。

从构建产物运行不联网示例：

```sh
pnpm build
pnpm test:agent-smoke
```

示例使用 `fixtures/model/continuity.json` 和显式授权的合成读取动作：第一轮读取人物资料，第二轮输出候选结论，检查工具结果、检查点、事件及未知用量。它不读取实际小说库，也不验证模型生成质量。

## 模型协议与 pi-ai

2026-11-03 再核查 npm stable/latest 为 `@earendil-works/pi-ai@1.5.0`，与 P01 锁文件一致，无新增依赖。适配实现以安装包的导出、类型及代码为准，使用各 API 的 `streamSimple`，并由真实 SDK 解析模拟 HTTP/SSE 测试。参考：[官方仓库](https://github.com/earendil-works/pi/tree/main/packages/ai)、[官方 README](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/ai/README.md)、[npm 元数据](https://registry.npmjs.org/@earendil-works%2fpi-ai/latest)。上游主分支可能领先锁定版本，不能直接照搬其接口签名。

`ModelAdapter` 有稳定 id、`stream(request, signal)` 和可选同步预检 `validateRequest(request)`。loop 在任何记录前执行预检；PiModelAdapter 用它验证连接及参数，非法 URL 凭据/查询串/片段不会先进入记录。自定义适配器须在预检中验证其特有配置，不能将秘密放入通用请求。共享运行时契约位于 `packages/shared/src/agent.ts`：

- 请求包含冻结的非敏感连接配置、modelId、systemPrompt、规范消息、动作 JSON Schema 和参数。
- 规范消息包含 user、assistant 和 toolResult。assistant 保存可见 content、完整 toolCalls 及可选 `protocol: {adapter, message}`；工具结果同时对应 toolCallId、toolName 和 result.callId。
- 流事件为 `text_delta`、`tool_call_delta`、唯一最终 `response`。最终响应含完整 assistant、text、calls、stop、usage 和可选 errorCode。
- pi-ai 的原始 assistant 消息保存在 protocol 中，保留响应 ID、工具 ID、思考/文本签名及原始用量，供下一轮和检查点恢复。原始错误文字及 diagnostics 不持久化。不能用仅含可见文字的消息恢复 pi-ai 对话。

当前支持 `openai-completions`、`openai-responses`、`anthropic-messages` 三种文本/工具协议。`connectionSnapshot` 按 `piConnectionSchema` 校验，字段为 api、provider、baseUrl、credentialRef、contextWindow、maxOutputTokens、reasoning、pricing；baseUrl 不含 URL 凭据、查询串或片段。pricing 可空，若提供则为 USD/百万 Token 的 input/output/cacheRead/cacheWrite 十进制单价。参数只接受 temperature、maxTokens，后者不得超出冻结配置上限。

凭据通过 `new PiModelAdapter({resolveCredential, fetch?})` 注入；resolver 按引用取秘密，不能把密钥放进请求、记录或检查点。适配器不隐式回退环境凭据，公网站点缺少引用/密钥返回 PROVIDER_AUTH_ERROR；无引用的 loopback 接口可使用本地占位 key。SDK `maxRetries=0`，禁用重定向，错误不会隐式多发计费调用。生产的连接授权及出站策略由 P05/server 负责，不能接受模型修改连接。

401/403、429、408、上下文超限和其他供应商错误分别归类；外部取消信号决定取消结果；应用不设置模型调用或整次运行计时器。供应商自行返回 aborted 且外部未取消时为失败，不伪装作者取消。测试全部使用注入的模拟 fetch，没有真实供应商连接或付费调用；真实连接验收留在 P05。

## 动作与完整轮次

`new ActionRegistry(handlers)` 接受程序注册的 search_documents、read_document、propose_document_change，以及后续加入的 load_skill、read_skill_file，可提供其中一部分；只向模型公布已提供的定义。循环和注册器不设置结果序列化长度上限。Skill 文字不能新增能力。处理器参数/结果类型由 shared 推导，运行时也验证，参数默认值在执行前填入。

完整响应通过文本/工具副本一致性、结束原因、call ID 唯一性及历史对应关系验证后，动作才按顺序执行。重复历史 ID 或协议损坏时整批不执行。流式 JSON 分片只产生展示事件，不猜测补全或提前执行。

未知动作、未提供能力、无效参数和可修正授权/版本错误返回结构化失败，允许模型读取错误后继续修正。工具自身的分页与结果结构契约仍生效，不切碎 JSON。错误结果保留 call ID；原始异常文字不暴露。STORAGE_ERROR、内部异常和非法处理器结果终止运行。提议处理器只能返回 staged 提议，不能修改正式文档。

P05 处理器必须验证冻结资料白名单、作品归属、版本及提议目标，并支持 AbortSignal。进入的原子动作允许结束，随后取消阻止下一动作/轮次；不配合信号且永不返回的处理器或记录器无法被 JavaScript 强制终止。数据库动作必须有限、短事务执行，不能在模型网络等待时持锁。

## 执行、状态与用量

2026-11-04：移除应用设置的轮数、单轮工具次数、模型调用超时、运行期限、累计 Token 预算及循环层的文本、参数、请求和工具结果长度上限。循环持续到模型正常完成、作者取消或实际错误；完成工具轮后继续请求模型，不因调用轮数停止。

旧请求中的 limits 字段接受后丢弃，不影响执行。历史限制错误码保留用于读取旧记录。模型本身的上下文容量、输出配置和供应商报告的截断仍按实际结果处理。取消可中断不配合信号的模型等待；原子动作和检查点提交规则不变。

| status    | stopReason                                                              |
| --------- | ----------------------------------------------------------------------- |
| completed | complete；无动作的正常完整响应已提交                                    |
| limited   | OUTPUT_TRUNCATED（供应商返回截断；历史限制码仅用于旧记录） |
| cancelled | cancelled；作者信号已接受                                               |
| failed    | MODEL_TIMEOUT、MODEL_PROTOCOL_ERROR、供应商/存储/内部错误等             |

流中断、缺失最终响应、最终响应后再发事件均不视为成功。已知用量即使响应其他字段失败也尽量保留，未完整提交轮次不能成为恢复点。

用量未知保留 null。pi-ai 将缺失 Token 数补为零，缺少字段存在证据，因此该适配器对零值保守记为未知；自定义/Fake 模型明确返回的零仍可记录为零。输入总量包括 cacheRead/cacheWrite，保留原始细项。仅供应商明确标记 `totalFromProvider` 的费用记 provider；冻结价格且计数已知时可估算并标 estimate，其余费用为 null。

汇总使用十进制运算，按币种保存 byCurrency，不把 USD/CNY 直接相加。known 保留已知部分，complete/inputComplete/outputComplete/costComplete 标出完整性，mixedSources 标记混合来源；费用已知不代表生成成功。多币种汇总的单一 cost 为 null。

用量与费用继续记录，但不以累计阈值终止执行。并发与排队由 P05 运行管理器实现。

## 记录器与检查点接入责任

`LoopRecorder` 有三个接口，`MemoryLoopRecorder` 仅供测试/示例，不提供持久化保证：

| 接口                     | P05 实现责任                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| record(record)           | 保存 request、模型增量、完整 response、action 或公开 event；事件落库后才发布，失败抛错                                                 |
| commitTurn(turn, signal) | 同一事务提交完整 assistant/工具结果、检查点、staged→pending 及 turn.events（proposal.created、turn.completed）；仅成功确认后推进恢复点 |
| finish(result, event)    | 原子保存运行终态与 run.finished；处理未提交 staged 提议及相关状态                                                                      |

检查点 schemaVersion=1，包含 adapterId、冻结 initialRequest、nextTurnIndex、全部规范 messages 和 lastTurn 的响应/结果。恢复时校验同适配器、同输入、历史 call/result 配对及最后轮次尾部；冻结输入之后的完整轮数必须对应 nextTurnIndex，不接受额外 user 消息或在先前正常完成轮后继续追加。校验是结构一致性验证，不是签名；P05 必须从可信数据库读取并验证 run/作品/Skill/模型配置归属，禁止信任客户端上传检查点。

重试创建新 run，只复用最近完整检查点，不重做其中已记录的动作。usage 按本次调用重新计算；历史费用仍属于原 run，P05 需要关联展示。逻辑 turnIndex 接着检查点，公开事件 seq 在新 run 默认从 1 起，initialSeq 只用于已有事件流。已正常完成的检查点无需模型也可返回结果，但 P05 应拒绝无意义的完成任务重试。不自动恢复崩溃任务或重发状态不明的调用。

record/commitTurn 失败返回 STORAGE_ERROR。finish 若失败，返回 recordingFailed=true、failed/STORAGE_ERROR；终态写入结果可能不确定，核心不反复写第二个终态事件。P05 必须协调持久化状态，启动时将遗留非终态标 interrupted。数据库提交后但响应丢失也需要按已存检查点对账。

公开事件仍为 schemaVersion=1，新增 `tool.arguments.delta {turnIndex, callIndex, delta}`，用于参数展示；`tool.started.name` 可记录未知动作名，但不授权其执行。其余事件见 shared/events.ts。公开事件序号单调递增；检查点与提议事件在 commitTurn 批次成功后才能发布。SSE 重放、幂等创建/接受、运行互斥、上下文与业务候选界面均由 P05 提供。

## 验证记录

`pnpm install --frozen-lockfile`、`pnpm check`、`node scripts/check-browser-build.mjs`、`pnpm test:agent-smoke`、`pnpm test:smoke`、`pnpm test:e2e` 均通过。首次验收为 116 项单元/集成测试；复查新增 9 项回归后，当前 9 个测试文件共 125 项，Chromium 13 项；P04 合计新增 67 项 loop/真实 SDK 离线测试。CI 增加离线 Agent 示例。

覆盖完整两轮、顺序动作、无效参数/权限/未知动作、参数分片、重复 ID、损坏/不完整协议、取消/超时/期限、文本/参数/结果与轮数限制、检查点恢复/拒绝、存储失败、提议激活边界、Token 限额、未知/部分用量与多币种。三种实际 SDK 协议均验证两轮工具消息及思考签名复建，HTTP 错误验证无自动重试、无密钥进入记录。

前端构建成功，仍有约 501 kB 压缩前主 chunk 的 Vite 提示；浏览器产物不含 agent/SDK/数据库/凭据标记。P04 没有新增前端代码，拆包优化不作为本阶段交付项。

## 复查修正（2026-11-03）

首次测试全部通过后，按主人的复查要求补充边界场景，先复现失败再修复了以下三处遗漏：

| 问题                                                              | 修复与回归                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| pi-ai 连接校验发生在请求记录之后，非法 baseUrl 的凭据可能进入记录 | 增加适配器预检，在所有 recorder 调用前验证；userinfo、query、fragment 三种情况均拒绝，记录器/凭据 resolver/fetch 均不调用            |
| 只有最终响应时，参数限制按单动作检查，未约束整批总量              | 全部 arguments 的 JSON 长度求和，超限整批不执行，与流式累计限制一致                                                                  |
| 检查点只验证最后轮次及局部消息配对，删除完整早期轮次仍可恢复      | 校验冻结输入之后的轮数、禁止插入用户消息及先前完成轮；覆盖丢轮、插入消息、提前完成和逻辑序号不符，并验证含初始聊天历史的多次合法恢复 |

这些修正属于 P04 核心范围；真实供应商、数据库事务及 SSE 仍需在 P05 单独验收。
