# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

灵码：AI 小说写作工作台。全栈 TypeScript，pnpm workspace（Node 22.19–22.x，pnpm 11.5.2，用 pnpm 不要用 npm）。项目文档以中文为主，先看 `README.md` 与 `docs/README.md`（每个功能模块有对应的实施说明，如 `docs/P05-写作流程实施.md`、`docs/MA-通用编排与流程画布实施.md`）。

## 常用命令

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev            # 先构建 shared/agent，再并行 watch shared/agent/server/web；前端 http://127.0.0.1:5173，/api 代理到 3000
pnpm build && pnpm start   # 构建后由 Node 同时提供前端和 API（3000）
pnpm typecheck      # 先构建 shared、agent（其他包依赖其 dist），再全量 tsc
pnpm lint           # biome check + scripts/check-boundaries.mjs
pnpm format         # biome check --write
pnpm test           # 先构建 shared/agent，再 vitest run
pnpm check          # typecheck + lint + test + build
pnpm test:smoke / test:agent-smoke / test:e2e   # 进程冒烟 / 离线 Agent 示例 / Playwright（均需先 pnpm build）
pnpm data:clean [--execute]  # 清理业务数据并保留模型配置与密钥（执行前必须停止服务）
```

单个测试：先构建内部包（`pnpm --filter @lingma/shared build && pnpm --filter @lingma/agent build`，构建过一次后源码未改动可跳过），然后 `pnpm exec vitest run apps/server/test/skills.test.ts` 或加 `-t "名称"`。测试位于各包 `test/`，以及根目录 `tests/`、`e2e/`（Playwright）。

## 架构

四个包，依赖方向由 `scripts/check-boundaries.mjs` 强制（lint 会失败）：

- `packages/shared`（`@lingma/shared`）：纯 zod schema 与领域类型，仅依赖 zod；前后端契约（api、skill、workflows、actions 等）都定义在这里。
- `packages/agent`（`@lingma/agent`）：自研 Agent loop，仅依赖 shared 和 pi-ai。可切换 Fake/pi-ai 模型；固定动作注册表、取消/超时/限额、完整轮次检查点、用量汇总。凭据和动作实现通过接口注入，包本身不接触数据库。
- `apps/server`：Hono + better-sqlite3。`http/` 路由 → `services/`、`writing/`、`workflows/`、`elements/`、`skills/` 业务 → `db/`、`storage/`。
- `apps/web`：React 19 + Vite + react-router + @xyflow/react（流程画布）。只依赖 shared，不能引用 server/agent。

要点：
- shared/agent 改动后，server/web 通过它们的 `dist` 消费，必须重新构建（`pnpm dev` 会 watch）。
- 数据全在 `DATA_DIR`（默认 `.data/`）：`workbench.sqlite`（WAL）、`blobs/<sha256>` 不可变附件、加密的模型密钥。实例锁保证单进程使用；仅允许 loopback 监听。
- 数据库迁移在 `apps/server/src/db/migrations/NNNN-*.sql`，启动时校验版本与 checksum：**不要修改已有迁移**，只能新增文件（当前至 0020）；未知新版本数据库会拒绝启动。
- 写作链路：`writing/`（上下文预算与预览、Agent 运行持久化、SSE、提议）。模型输出仅作为候选/提议，须由作者接受才写入新文档版本。
- 多 Agent 编排：`workflows/`（角色库、模板、`graph.ts` 轮次与就绪判断、`adapters.ts` Markdown→类型化结果、闸门/采纳/重跑、检查点恢复；产物是 Markdown，不再做 JSON 补全）；运行共用全局执行队列（同时执行 1 个）。通用编排覆盖正文/基础信息/世界观/总纲/事件，前端在 `WorkflowStudio`/`WorkflowGraphEditor` 配置模板，在写作助手中运行。
- Skill：通用 Skill 与项目 Skill（`0019-skill-scopes`）分范围管理，支持文件/目录/Git 导入（`skills/git*.ts`，仅公网 HTTPS），脚本只存储不执行；Agent 通过 `load_skill`、`read_skill_file` 动作使用。
- 前端路由为多页面（`/projects`、作品内写作/大纲/基本信息/项目 Skill，以及独立的通用 Skill、Agent 角色、工作流模板、模型设置、Agent 提示词），路由逻辑见 `apps/web/src/workspace-route.ts`。

## 约定

- 代码风格由 Biome 管理（`pnpm format`）；提交前跑 `pnpm lint` 和相关测试。
- 不调用付费供应商：写作类浏览器测试使用真实 pi-ai SDK + 本地 HTTP 模拟接口。
- 修改功能时同步更新对应 `docs/*实施.md` 与 README 中的状态描述（项目惯例）。
