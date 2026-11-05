# 合成开发样本

来源：2026-11-03 为本仓库人工编写的虚构短篇《雾港来信》，不摘录真实作品，不含个人资料、密钥或受限内容。可以在本项目开发和测试中复用；后续真实存稿应另行获得授权，不覆盖此固定样本。

| 文件                       | 用途                                          |
| -------------------------- | --------------------------------------------- |
| novel/存稿.md              | UTF-8 Markdown，多章标题；包含空行、中文标点  |
| novel/存稿.txt             | 对应 UTF-8 TXT 导入样本                       |
| novel/人物.md              | 姓名、别名、惯用手和物品归属                  |
| novel/章纲.md              | 第三章未来规划，与已发生前文分开              |
| novel/矛盾候选.md          | 故意注入可定位的矛盾                          |
| skills/continuity/SKILL.md | 有 front matter、关联文件、示例的提示词 Skill |
| cases/continuity.json      | 固定输入、明确允许的资料、预期观察            |
| model/continuity.json      | 两轮假模型事件：先请求读取，再给出候选结论    |

观察点：前文及人物资料均说明林舟惯用左手、铜铃交给苏禾；候选却改成惯用右手、铜铃始终由自己保管。第三章章纲属于未来，不应被当成已发生事件。审校建议须引用实际输入的资料；生成提议后仍须作者接受才能改变文档。

这些是测试期望，不是模型能力或文风质量评分。P01 不导入这些资料到业务库，不发起付费请求；P02—P05 复用合成资料建立各自验收。

P04 已使用 `model/continuity.json` 验证两轮循环：assistant 含规范 content/toolCalls，第一轮 read_document 的完整调用与下一轮 toolResult 按 ID 对应。执行 `pnpm build` 后可用 `pnpm test:agent-smoke` 运行；示例只注入合成资料，不读取实际数据库、不调用网络或供应商。真实 SDK 的三种协议另用内存 HTTP/SSE 样本测试，详见 [P04 实施说明](../docs/P04-Agent循环实施.md)。

P05 浏览器验收在临时实例创建人物、正文和 Skill，通过真实 pi-ai SDK 请求 `scripts/model-fixture.mjs` 的本机 HTTP/SSE 接口，完成读取→提议→候选→人工接受。`scripts/sse-test-proxy.mjs` 实际切断事件流、记录原生 EventSource 重连请求头。它们只由 E2E 启动器启用，不属于生产模型配置或服务路由；20/5 Token 为合成统计，不能证明真实供应商费用或质量。详见 [P05 实施说明](../docs/P05-写作流程实施.md)。
