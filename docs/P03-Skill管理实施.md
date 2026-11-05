# P03：Skill 管理实施与接口

日期：2026-11-03。当前实现以 `packages/shared/src/skill.ts`、`apps/server/src/skills/`、`apps/server/src/services/skills.ts` 和 `apps/web/src/components/SkillManager.tsx` 为准。以下是实施采用，不替代 PRD 中尚未填写的主人回答。

## 使用方式

左侧“创作工具 → 通用 Skill”进入 `/skills`，管理所有项目可用的 Skill；“当前作品 → 项目 Skill”进入 `/projects/:projectId/skills`，管理当前项目专属 Skill。两个页面均支持导入、编辑、历史比较与来源更新，小说编辑及保存队列继续保留。

2026-11-05 增加迁移 `0019-skill-scopes.sql`：Skill 与导入任务的 `project_id` 为空表示通用，非空表示所属项目；已有记录默认通用。详情“Skill 归属”可修改归属，保留所有不可变版本与附件；来源更新中禁止修改。目标项目必须存在且不在回收站，异步导入发布前再次校验。写作上下文使用通用及当前项目的目录；显式指定其他项目版本返回 403，角色试运行与工作流执行同样校验项目范围，只加载角色选定版本。已冻结的运行快照继续使用原先固定版本。

列表与任务接口支持 `scope=general`、`scope=project&projectId=UUID`；仅传 `projectId` 返回通用加该项目可用项，不传范围只返回通用项。分页在筛选后进行。本地 multipart 和 Git JSON 导入可传 `projectId`，空值默认通用；已有 Skill 的来源更新继承其归属。`PATCH /skills/:id/scope` 接收 `{baseVersionId,projectId}` 修改归属，`projectId:null` 表示通用。

- “导入 Skill”可选择单个 SKILL.md、多文件集、完整 Skill 目录或包含多个 Skill 的父目录。浏览器递归识别 SKILL.md 所在目录，按 Skill 拆分后逐项上传并等待导入完成，再处理下一项。每项保留自己的附件和来源目录名，目录外的无关文件忽略并计数。若某目录本身已经是 Skill，其内部示例中的 SKILL.md 作为附件保留，不另行拆分。
- 批量导入每项独立使用原单 Skill API 和大小限制，总文件数可以超过 200。明确的 PROJECT_BUSY 拒绝稍后重试；已接受的任务按 ID 查询到终态后才继续，短暂查询连接/代理失败只重试读取。上传结果不明时不自动重发，避免重复创建。单项失败继续后续项，界面展示完成数、失败数及各目录错误。非 JSON 响应显示实际 HTTP 状态。
- 单文件可导入，正文中的本地 Markdown 链接和引用式链接会检查附件是否存在；缺失文件明确列出，可上传完整目录建立新版本补齐。没有访问作者电脑路径的服务端接口。
- Git 填写公开 HTTPS 仓库及 Skill 子目录。使用默认分支的实际 HEAD 提交进行浅克隆，仅将指定目录内的文件发布为 Skill 副本；其他 Skill 不进入 manifest。
- 可预览正文、元数据、文件及 examples / example / samples / sample 目录中的示例。内嵌示例仍出现在正文中；没有示例文件时明确显示为空，不生成假示例。
- “编辑 SKILL.md”编辑完整入口源码，包括 front matter。保存需要点击“保存新版本”；成功后才更新基准，失败保留编辑，409 后展示最新正文与本地编辑差异。作者可合并并采用最新基准再保存，或明确放弃编辑。
- 历史版本只读，可分页加载、选定版本并比较入口、附件 manifest 和来源。界面显示可复制的 `skillVersionId`；P05/P06 尚未接入执行和实验。
- Git 来源的“从 Git 更新为新版本”和本地来源的“上传完整目录更新”均为显式完整替换，保留旧版本。存在未保存入口编辑时禁止发起来源更新。Git 更新完成后，通过任务记录“打开导入版本”查看新版本。

Skill 编辑是显式保存。窗口关闭或切换 Skill/版本时会提示放弃未保存编辑，浏览器离开也会提示；当前没有 Skill 草稿刷新恢复保证。小说自动保存及 sessionStorage 恢复行为继续沿用 P02。

## 格式与文件限制

| 项目         | 本次采用                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 入口         | 根部 SKILL.md，严格 UTF-8，有效 Unicode、无 NUL；UTF-8 BOM 和原始换行保留                                                                              |
| front matter | 可选 YAML 1.2 core 对象，保留未知 JSON 兼容字段；拒绝重复键、自定义标签、别名、非有限数值；元数据最多 65536 字符                                       |
| 名称         | 优先 metadata.name，其次正文首个一级标题，最后“未命名 Skill”；列表名最多 200 字符，原入口/元数据不截断                                                 |
| 文件         | 每个 Skill 最多 200 个，单文件 2 MiB，总计 16 MiB；入口最多 256 KiB；每个请求体最多 17 MiB                                                             |
| 路径         | NFC 标准化相对路径，最多 16 层；拒绝绝对路径、点段、反斜杠、控制字符、危险设备名、.git/.hg/.svn、尾部点/空格、大小写或 Unicode 等价重复、文件/目录冲突 |
| Git          | 无凭据 HTTPS，443 端口，无查询参数/fragment；全部 HTTP 响应体累计最多 32 MiB，整体最多 60 秒；最多同时 2 个导入任务                                    |
| Git 目录遍历 | 所选 Skill 最多 1200 个目录项，最多 16 层；仅普通文件/目录，拒绝符号链接及子模块，不做 checkout                                                        |
| 预览         | React Markdown 禁用原始 HTML，外部图片不加载；Markdown 与无 NUL 的 UTF-8 附件可查看，其他文件仅下载；没有富媒体预览                                    |

Markdown 本地链接按清单读取，不跨 Skill 根目录；外部 HTTPS/HTTP 链接只在作者点击后打开。脚本即使被导入也只作为不可变字节保存，不能执行，不能动态注册工具，附件不自动全部加入模型上下文。附件本身的相对链接仅支持不含父目录跳转的子路径；不支持的链接保持禁用。

Git 采用 `isomorphic-git 1.44.10`，没有 shell 命令、系统 Git、凭据助手、hooks、子模块递归或推送。自定义 Node HTTPS 传输逐次检查目标 origin/仓库路径，只接受公网 DNS 结果，并固定解析出的地址到连接；拒绝私网、回环、链路本地、特殊地址（额外拒绝 168.63.129.16）、所有 HTTP 重定向及非 identity 的 HTTP 内容编码。库的传输接口见[官方文档](https://isomorphic-git.org/docs/en/http)。YAML 使用 [yaml 2.9.1](https://eemeli.org/yaml/)，预览使用 [react-markdown 10.1.0](https://github.com/remarkjs/react-markdown)，网络地址分类使用 ipaddr.js 2.5.0。

Git 在独立 Node Worker 中处理，V8 堆限制为 192 MiB，超时/取消时终止 Worker，再清理私有临时目录。该堆设置不代表操作系统总内存硬隔离。Node 22.19+ 开发态使用原生 TypeScript 擦除运行 Worker，生产运行 tsc 编译产物，所有 Worker 代码纳入严格类型检查。默认分支浅克隆仍可能下载仓库中其他目录的对象；32 MiB 下载限制针对整个获取，不能通过选择小子目录绕过。只支持兼容的公开 Git Smart HTTP 来源，不支持私有认证、自选分支/标签、LFS 实体下载或需要重定向的仓库 URL。

本地浏览器上传不能提供符号链接的类型证明；服务只接收文件字节并校验相对路径，不在作者电脑或服务器来源路径上遍历。Git 导入则直接检查树对象类型并拒绝链接。

## 不可变发布与持久化任务

新增迁移 `0003-skill-imports.sql`，schemaVersion=3，仅增加 `skill_import_jobs`；0001/0002 不修改，既有作品、Skill 表和不可变历史保持兼容。

1. 创建 queued 任务，Git 下载时更新为 fetching。
2. 校验完整文件集、入口及元数据，进入 publishing。逐个将所有文件（含 SKILL.md）写入 SHA-256 blob；先完成文件发布，再建立数据库引用。
3. 短事务中再次检查 `baseVersionId`，建立不可变 `skill_versions` / `skill_files`、更新当前指针与来源，并将任务置为 completed。事务失败不发布任何半成品版本，允许留下未引用 blob。
4. 手动编辑继承基准版本的附件及来源快照，保存前校验继承附件仍存在且完整，仅入口 blob 改变；并发冲突不推进指针。
5. 显式来源更新使用开始时的基准，下载中出现的新编辑会使最终发布失败，而不会覆盖新编辑。即使 Git 提交没有变化，显式更新也新增版本，保留此前本地编辑。

manifest 包含相对路径、blobHash、mediaType、sizeBytes（包括入口），按 UTF-8 路径字节序排序，字段按 shared schema 顺序序列化后计算 SHA-256。入口原文、解析元数据、来源 type/ref/commit/subdir 和 manifest 全部随版本固定。读取附件必须匹配版本 manifest，再从 blob 存储读取并校验 SHA-256。

导入状态：queued → fetching（Git）→ publishing → completed，失败为 failed，关闭/重启中断为 interrupted。正常关闭先取消任务，再关闭数据库；重启时将上次未完成任务标为 interrupted。任务状态和结果 ID 持久化，不自动重放上传或网络请求。界面展示最近 50 个任务；列表及版本使用游标分页。

正常成功/失败/超时后清理 Git 暂存目录。进程被强制杀死可能留下临时目录；当前不提供自动孤立 blob/强杀暂存目录回收，不将删除历史或附件回收纳入本阶段。

## HTTP API

前缀 `/api/v1`。单资源 `{data}`，列表 `{data,nextCursor}`。沿用 Host/Origin/readiness、no-store、统一错误和不含正文/凭据的日志。

| 方法与路径                                        | 输入 / 输出                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET /skills                                       | limit 1—200、UUID cursor；Skill 名称、当前版本及当前来源                                        |
| POST /skills/import/local                         | multipart：重复 files、JSON 数组 paths；可选 skillId + baseVersionId 更新已有副本；202 返回任务 |
| POST /skills/import/git                           | repository、subdir（根部为空串）；202 返回任务                                                  |
| GET /skill-imports                                | 最近 50 个任务，`{data:[]}`                                                                     |
| GET /skill-imports/:jobId                         | 持久化状态、来源、版本 ID 和可展示错误                                                          |
| GET /skills/:id                                   | 当前 Skill、不可变 version、解析预览及缺失文件                                                  |
| PUT /skills/:id                                   | baseVersionId、entryContent；返回新详情；过期基准 409 VERSION_CONFLICT                          |
| POST /skills/:id/update-source                    | baseVersionId；Git 来源重新获取，202 返回任务                                                   |
| GET /skills/:id/versions                          | limit、正安全整数 cursor；倒序版本摘要                                                          |
| GET /skills/:id/versions/:versionId               | 指定历史详情，校验属于此 Skill                                                                  |
| GET /skill-versions/:versionId                    | 仅按不可变 skillVersionId 精确读取运行快照                                                      |
| GET /skills/:id/versions/:versionId/file?path=... | 仅 manifest 中路径，octet-stream + attachment + nosniff + sandbox CSP                           |

失败不会把原始数据库/网络异常、入口内容或完整请求记录进日志。文件下载不能作为 HTML/脚本内联执行。P07 的服务端认证需要继续覆盖这些业务、附件及状态端点。

## 验证

- `pnpm check`：类型检查（包含 Worker/测试）、Biome/依赖边界、Vitest、全量构建。
- Vitest 共 58 项，其中本阶段新增 17 项：可选 front matter/未知字段、坏编码/BOM/NUL、路径与大小、单文件与完整目录、继承附件、回滚、实际提交及来源更新、下载中编辑冲突、任务重启/关闭、真实 multipart、不可变 ID 读取、损坏附件、DNS 固定/私网/重定向/超限流、指定 Git 子树/符号链接、真实 Worker 拒绝回环与取消清理。
- Chromium 共 13 项，其中新增 5 项：实际目录选择上传、示例、编辑/历史差异、移动宽度、恶意 HTML/图片不执行、不请求外部图片、双版本冲突合并、保存失败重试、Git 私网拒绝及刷新后任务仍可读。原 P02 的 8 个流程全量回归。
- `node scripts/check-browser-build.mjs`、`pnpm test:smoke` 验证生产资源、开发代理、独占锁、无效配置、SIGTERM 和重启。
- `pnpm test:skill-git` 是显式联网冒烟（先 build），不加入普通 CI：公开仓库 → 指定子目录 → 校验每个附件 → 本地编辑 → 显式更新 → 校验两个旧版本仍可读。可传仓库与子目录覆盖默认值。

2026-11-03 实际联网样本为 `https://github.com/obra/superpowers.git` 的 `skills/brainstorming`，提交 `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`，导入 8 个文件，编辑/来源更新后共 3 个版本，旧快照保持不变。外部内容仅在临时测试实例保存后清理，没有加入项目 fixture，也没有执行其中的脚本或调用模型。CI 继承上述离线检查和浏览器测试，未在远端运行。
