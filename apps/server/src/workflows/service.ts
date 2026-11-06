import { randomUUID } from 'node:crypto';
import {
  ActionError,
  type ActionHandlers,
  ActionRegistry,
  LoopStop,
  UsageAccumulator,
  type UsageSummary,
} from '@lingma/agent';
import {
  type AgentProfileVersion,
  basicInformationKinds,
  type ContextPreview,
  effectiveAdoption,
  elementLabels,
  isWorkflowOutputKind,
  jsonSchema,
  type LoopCheckpoint,
  parseReviewMarkdown,
  type ReviewIssue,
  renderIssuesMarkdown,
  type WorkflowArtifact,
  type WorkflowArtifactKind,
  type WorkflowDecision,
  type WorkflowInput,
  type WorkflowNode,
  type WorkflowPreview,
  type WorkflowRun,
  workflowInputSchema,
  workflowPreviewSchema,
  workflowRunSchema,
  writingRunInputSchema,
} from '@lingma/shared';
import { AppError } from '../errors.js';
import type { SkillService } from '../services/skills.js';
import { actualActions } from '../writing/actions.js';
import { digest, stable } from '../writing/context.js';
import { estimateTokens } from '../writing/estimate.js';
import type { WritingService } from '../writing/service.js';
import { active, decode, emptyUsage, now, type Row } from '../writing/store.js';
import { buildWorkflowResult } from './adapters.js';
import { initialNodes, nextRoundNodes, readyNode, upstreamTemplateKeys } from './graph.js';
import { AgentLibrary } from './library.js';
import { prepareProfileContext } from './profile-context.js';
import { artifactKind, stageGuide } from './prompts.js';
import { acceptWorkflowOutput, assertWorkflowTarget } from './results.js';

const held = [
  'queued',
  'running',
  'awaiting_input',
  'awaiting_acceptance',
  'paused',
  'interrupted',
  'failed',
  'limited',
];
export class WorkflowService {
  readonly library: AgentLibrary;
  private stopped = false;
  private pumping: Promise<void> | undefined;
  constructor(
    readonly writing: WritingService,
    readonly skills: SkillService,
  ) {
    this.library = new AgentLibrary(writing.store, skills);
    this.store.database.transaction(() => {
      for (const row of this.db
        .prepare("SELECT state_json FROM workflow_runs WHERE status IN ('queued','running')")
        .all() as Row[]) {
        const w = workflowRunSchema.parse(decode(row.state_json));
        w.status = 'interrupted';
        w.reason = '服务已重启，请显式恢复';
        for (const n of w.nodes)
          if (
            ['queued', 'running'].includes(n.status) &&
            this.store.summary(n.runIds.at(-1) as string).status !== 'completed'
          )
            n.status = 'interrupted';
        this.save(w, 'workflow.interrupted');
      }
    });
  }
  get store() {
    return this.writing.store;
  }
  get db(): WritingService['store']['db'] {
    return this.store.db;
  }
  get(id: string): WorkflowRun {
    const row = this.db.prepare('SELECT state_json FROM workflow_runs WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', '工作流不存在', 404);
    const w = workflowRunSchema.parse(decode(row.state_json));
    this.store.novels.getProject(w.projectId);
    w.sourceChanges = [
      ...new Map(
        Object.values(w.snapshot.contexts)
          .flatMap((p) => p.allowed)
          .map((ref) => [ref.documentId, ref]),
      ).values(),
    ]
      .filter((ref) => {
        const doc = this.store.novels.getDocument(ref.documentId, true).document;
        const accepted = w.acceptedResults.find((item) => item.documentId === ref.documentId);
        if (accepted?.versionId === doc.currentVersionId && doc.deletedAt === null) return false;
        return doc.currentVersionId !== ref.versionId || doc.deletedAt !== null;
      })
      .map((ref) => ref.title);
    if (w.proposalId) w.proposal = this.store.proposal(w.proposalId);
    const usage = new UsageAccumulator();
    const costs = new UsageAccumulator();
    let complete = true;
    for (const n of w.nodes)
      for (const id of n.runIds) {
        const summary = this.store.summary(id);
        usage.set(usage.begin(), summary.usage.known);
        complete &&= summary.usage.complete;
        const details = decode<Partial<UsageSummary>>(this.store.row(id).usage_json);
        const currencies =
          details.byCurrency ??
          (summary.usage.known.cost ? [{ ...summary.usage.known.cost, mixedSources: false }] : []);
        for (const cost of currencies)
          costs.set(costs.begin(), {
            inputTokens: null,
            outputTokens: null,
            cost: { amount: cost.amount, currency: cost.currency, source: cost.source },
          });
      }
    if (w.nodes.some((n) => n.runIds.length)) {
      const u = usage.summary();
      w.usageByCurrency = costs.summary().byCurrency;
      w.usage = {
        known: { ...u.known, cost: costs.summary().known.cost },
        complete: u.complete && complete,
      };
    }
    return w;
  }
  list(projectId: string, sessionId?: string) {
    this.store.novels.getProject(projectId);
    return (
      this.db
        .prepare(
          "SELECT id FROM workflow_runs WHERE project_id=? AND (? IS NULL OR json_extract(state_json,'$.snapshot.input.sessionId')=?) ORDER BY created_at DESC,id DESC LIMIT 100",
        )
        .all(projectId, sessionId ?? null, sessionId ?? null) as { id: string }[]
    ).map((r) => this.get(r.id));
  }
  private save(w: WorkflowRun, type: string) {
    w.revision++;
    w.updatedAt = now();
    this.db
      .prepare('UPDATE workflow_runs SET status=?,state_json=?,updated_at=? WHERE id=?')
      .run(w.status, JSON.stringify(w), w.updatedAt, w.id);
    if (w.snapshot.input.sessionId)
      this.db
        .prepare('UPDATE sessions SET updated_at=? WHERE id=?')
        .run(w.updatedAt, w.snapshot.input.sessionId);
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM workflow_events WHERE workflow_id=?')
      .get(w.id) as { seq: number };
    this.db.prepare('INSERT INTO workflow_events VALUES(?,?,?)').run(
      w.id,
      row.seq,
      JSON.stringify({
        workflowId: w.id,
        seq: row.seq,
        type,
        status: w.status,
        revision: w.revision,
        createdAt: w.updatedAt,
      }),
    );
  }
  events(id: string, after: number) {
    this.get(id);
    const max = (
      this.db
        .prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM workflow_events WHERE workflow_id=?')
        .get(id) as { seq: number }
    ).seq;
    if (after > max) throw new AppError('VALIDATION_ERROR', '事件游标超过当前序号', 400);
    return (
      this.db
        .prepare(
          'SELECT event_json FROM workflow_events WHERE workflow_id=? AND seq>? ORDER BY seq LIMIT 100',
        )
        .all(id, after) as Row[]
    ).map((r) => decode(r.event_json));
  }
  async preview(raw: WorkflowInput): Promise<WorkflowPreview> {
    const input = workflowInputSchema.parse(raw);
    delete input.expectedPreviewHash;
    assertWorkflowTarget(this.store, input);
    const template = this.library.templateVersion(input.templateVersionId);
    this.library.validateTemplate(template.config);
    if (template.config.taskType !== input.taskType)
      throw new AppError('VALIDATION_ERROR', '模板用途与任务目标不匹配', 400);
    if (input.sessionId) {
      const session = this.db
        .prepare('SELECT project_id,deleted_at FROM sessions WHERE id=?')
        .get(input.sessionId) as Row | undefined;
      if (!session || session.project_id !== input.projectId || session.deleted_at)
        throw new AppError('FORBIDDEN', '会话不属于当前作品或已删除', 403);
    }
    const profiles = [...new Set(template.config.steps.map((s) => s.agentVersionId))].map((id) =>
      this.library.profileVersion(id),
    );
    const contexts: Record<string, ContextPreview> = {};
    for (const p of profiles) contexts[p.id] = await prepareProfileContext(this, input, p);
    const preview = {
      input,
      template,
      profiles,
      contexts,
      warnings: [
        '输入 Token 为保守估算；上游稿件将在节点开始前再次检查预算。',
        '自定义角色可复用当前模型；所有节点共用全局执行队列。',
      ],
    };
    return workflowPreviewSchema.parse({ ...preview, hash: digest(stable(preview)) });
  }
  async testProfile(profileId: string, revision: number, input: WorkflowInput, key: string) {
    const request = { profileId, revision, input };
    const prior = this.store.prior<{ id: string }>('profile:test', key, request);
    if (prior) return this.testResult(prior.id);
    const profile = this.library.profile(profileId);
    this.library.assertRevision(profile.revision, revision);
    if (profile.archived) throw new AppError('FORBIDDEN', '请先取消归档', 403);
    if (input.taskType === 'basic_information') assertWorkflowTarget(this.store, input);
    const p: AgentProfileVersion = {
      id: randomUUID(),
      profileId,
      versionNo: 1,
      config: profile.draft,
      createdAt: now(),
    };
    const preview = await prepareProfileContext(this, input, p);
    const target =
      input.targetDocumentId && input.baseVersionId
        ? this.store.novels.assertVersion(input.targetDocumentId, input.baseVersionId)
        : null;
    if (target && target.document.projectId !== input.projectId)
      throw new AppError('FORBIDDEN', '试运行目标不属于作品', 403);
    const first = preview.request.messages[0];
    const data = JSON.parse(first?.role === 'user' ? first.content : '{}');
    const sample = target?.version.content || '（空白章节）';
    preview.request.messages = [
      {
        role: 'user',
        timestamp: 0,
        content: JSON.stringify({
          ...data,
          workflowNode: { key: 'trial', stage: p.config.capability },
          upstream: p.config.capability === 'review' ? [{ kind: 'draft', markdown: sample }] : [],
        }),
      },
    ];
    preview.estimatedInputTokens = estimateTokens(preview.request);
    if (preview.estimatedInputTokens > preview.inputLimit)
      throw new AppError('CONTEXT_TOO_LARGE', '试运行上下文超出预算', 422);
    preview.hash = digest(stable(preview));
    const run = this.store.once('profile:test', key, request, () => {
      this.library.assertRevision(this.library.profile(profileId).revision, revision);
      const run = this.store.create(
        writingRunInputSchema.parse({
          projectId: input.projectId,
          sessionId: null,
          purpose: 'skill_test',
          input: input.input,
          providerConfigId: p.config.providerConfigId ?? input.providerConfigId,
          modelId: preview.request.modelId,
          context: {
            selectedVersionIds: [],
            allowedVersionIds: preview.allowed.map((r) => r.versionId),
            allowSearch: p.config.tools.includes('search_documents'),
            allowFutureOutline: input.allowFutureOutline,
          },
        }),
        preview,
      );
      this.db
        .prepare('INSERT INTO workflow_node_attempts VALUES(?,NULL,?,?,NULL)')
        .run(run.id, 'trial', JSON.stringify({ profile: p, taskType: input.taskType }));
      return run;
    });
    this.writing.wake();
    return this.testResult(run.id);
  }
  testResult(runId: string) {
    const binding = this.binding(runId);
    if (!binding || binding.workflow_id) throw new AppError('NOT_FOUND', '角色试运行不存在', 404);
    const run = this.store.detail(runId);
    return { run, artifact: run.status === 'completed' ? (run.output?.text ?? null) : null };
  }
  async create(raw: WorkflowInput, key: string) {
    const input = workflowInputSchema.parse(raw);
    const prior = this.store.prior<WorkflowRun>('workflow:create', key, input);
    if (prior) return this.get(prior.id);
    const snapshot = await this.preview(input);
    if (input.expectedPreviewHash && input.expectedPreviewHash !== snapshot.hash)
      throw new AppError('VERSION_CONFLICT', '配置或资料已变化，请重新预览', 409);
    const result = this.store.once(
      'workflow:create',
      key,
      input,
      () => {
        assertWorkflowTarget(this.store, input);
        if (
          this.db
            .prepare(
              "SELECT id FROM element_generation_jobs WHERE project_id=? AND status IN ('queued','running')",
            )
            .get(input.projectId)
        )
          throw new AppError('PROJECT_BUSY', '作品正在生成基本信息，请先结束', 409);
        if (
          this.db
            .prepare(
              "SELECT id FROM workflow_runs WHERE project_id=? AND status IN ('queued','running','awaiting_input','awaiting_acceptance','paused','interrupted','failed','limited')",
            )
            .get(input.projectId) ||
          this.db
            .prepare(
              "SELECT id FROM runs WHERE project_id=? AND (purpose IN ('write','rewrite') OR json_extract(input_json,'$.allowTargetProposal')=1 OR json_extract(input_json,'$.allowOutlineCreation')=1 OR json_extract(input_json,'$.allowChapterCreation')=1 OR session_id=?) AND status IN ('queued','running','cancelling')",
            )
            .get(input.projectId, input.sessionId)
        )
          throw new AppError('PROJECT_BUSY', '作品已有写作或工作流，请先结束', 409);
        if (input.sessionId) {
          const session = this.db
            .prepare('SELECT project_id,deleted_at FROM sessions WHERE id=?')
            .get(input.sessionId) as Row | undefined;
          if (!session || session.project_id !== input.projectId || session.deleted_at)
            throw new AppError('FORBIDDEN', '会话不可用', 403);
        }
        const nodes = initialNodes(snapshot.template.config);
        if (input.manualGates) for (const n of nodes) n.gate = 'manual';
        const w = workflowRunSchema.parse({
          id: randomUUID(),
          revision: 1,
          projectId: input.projectId,
          targetDocumentId: input.targetDocumentId,
          status: 'queued',
          reason: null,
          createdAt: now(),
          updatedAt: now(),
          snapshot,
          nodes,
          artifacts: [],
          latestDraftId: null,
          revisionCount: 0,
          modelCalls: 0,
          elapsedMs: 0,
          pauseRequested: false,
          proposalId: null,
          proposal: null,
          outcome: null,
          feedback: '',
          usage: emptyUsage,
        });
        this.db
          .prepare('INSERT INTO workflow_runs VALUES(?,?,?,?,?,?)')
          .run(w.id, w.projectId, w.status, JSON.stringify(w), w.createdAt, w.updatedAt);
        if (input.sessionId)
          this.db
            .prepare('UPDATE sessions SET updated_at=? WHERE id=?')
            .run(w.createdAt, input.sessionId);
        this.save(w, 'workflow.created');
        return w;
      },
      202,
    );
    void this.pump();
    return result;
  }
  private again = false;
  pump(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // A request that arrives mid-scan schedules one more pass so no decision is missed.
    if (this.pumping) {
      this.again = true;
      return this.pumping;
    }
    this.pumping = this.advance()
      .finally(() => {
        this.pumping = undefined;
      })
      .then(() => {
        if (!this.again) return;
        this.again = false;
        return this.pump();
      });
    return this.pumping;
  }
  private async advance() {
    for (const row of this.db
      .prepare(
        "SELECT id FROM workflow_runs WHERE status IN ('queued','running') ORDER BY created_at,id",
      )
      .all() as { id: string }[]) {
      if (this.stopped) break;
      try {
        this.store.database.transaction(() => this.advanceOne(this.get(row.id)));
      } catch (error) {
        this.store.database.transaction(() => {
          const w = this.get(row.id);
          if (!['queued', 'running'].includes(w.status)) return;
          w.status =
            error instanceof AppError && error.code === 'CONTEXT_TOO_LARGE' ? 'limited' : 'failed';
          w.reason = error instanceof AppError ? error.message : '工作流执行异常，请重试或结束';
          w.reasonCode = null;
          this.save(w, 'workflow.failed');
        });
      }
    }
  }
  private wait(
    w: WorkflowRun,
    reasonCode: WorkflowRun['reasonCode'],
    reason: string,
    type: string,
  ) {
    w.status = 'awaiting_input';
    w.reasonCode = reasonCode;
    w.reason = reason;
    this.save(w, type);
  }
  private artifact(id: string | null, w: WorkflowRun) {
    return id ? w.artifacts.find((a) => a.id === id) : undefined;
  }
  /** The newest non-stale artifact produced by a template node, across rounds. */
  private latestOf(w: WorkflowRun, templateKey: string): WorkflowArtifact | undefined {
    for (let i = w.nodes.length - 1; i >= 0; i--) {
      const n = w.nodes[i] as WorkflowNode;
      if (n.templateKey === templateKey && n.status !== 'stale' && n.artifactId)
        return this.artifact(n.artifactId, w);
    }
    return undefined;
  }
  private currentRound(w: WorkflowRun) {
    return w.nodes.reduce((max, n) => Math.max(max, n.round), 0);
  }
  private advanceOne(w: WorkflowRun) {
    const running = w.nodes.find((n) => ['queued', 'running'].includes(n.status));
    if (running?.runIds.length) {
      const id = running.runIds.at(-1) as string;
      const run = this.store.summary(id);
      if (active(run.status)) {
        if (running.status !== run.status && run.status === 'running') {
          running.status = 'running';
          this.save(w, 'node.started');
        }
        return;
      }
      w.elapsedMs += this.executionElapsed(id, run.finishedAt ?? now());
      const text = (
        this.store.row(id).output_json
          ? decode<{ text?: string }>(this.store.row(id).output_json).text
          : ''
      )?.trim();
      if (run.status !== 'completed' || !text) {
        running.status =
          run.status === 'limited'
            ? 'limited'
            : run.status === 'interrupted'
              ? 'interrupted'
              : 'failed';
        running.error = run.status === 'completed' ? '模型没有返回内容' : run.stopReason;
        if (!running.required && running.stage === 'review') {
          running.status = 'skipped';
          this.save(w, 'node.skipped');
        } else {
          w.status =
            running.status === 'limited'
              ? 'limited'
              : running.status === 'interrupted'
                ? 'interrupted'
                : 'failed';
          w.reason = `${running.name}：${running.error}`;
          w.reasonCode = null;
          this.save(w, 'node.failed');
          return;
        }
      } else {
        this.publishNode(w, running, text, id);
        if (w.status === 'awaiting_input') return;
      }
    }
    if (w.pauseRequested) {
      w.status = 'paused';
      w.pauseRequested = false;
      w.reason = '已在节点边界暂停';
      w.reasonCode = null;
      this.save(w, 'workflow.paused');
      return;
    }
    const interrupted = w.nodes.find((n) => n.status === 'interrupted');
    if (interrupted) {
      this.enqueue(w, interrupted);
      return;
    }
    const next = readyNode(w.nodes.filter((n) => n.status !== 'stale'));
    if (next?.stage === 'merge') {
      this.runMerge(w, next);
      // An auto-released merge continues straight into the round decision.
      if (w.status === 'awaiting_input') return;
      this.advanceOne(w);
      return;
    }
    if (next) {
      this.enqueue(w, next);
      return;
    }
    if (w.nodes.some((n) => ['pending', 'queued', 'running', 'awaiting_gate'].includes(n.status)))
      return;
    this.afterRound(w);
  }
  private publishNode(w: WorkflowRun, node: WorkflowNode, markdown: string, runId: string) {
    const task = w.snapshot.input.taskType;
    const kind = artifactKind(node, task);
    const draft = this.artifact(w.latestDraftId, w);
    const artifact: WorkflowArtifact = {
      id: randomUUID(),
      workflowId: w.id,
      nodeKey: node.key,
      round: node.round,
      runId,
      kind,
      markdown,
      contentHash: digest(markdown),
      inputArtifactIds: node.inputArtifactIds,
      createdBy: 'model',
      supersedes: null,
      issues:
        kind === 'review'
          ? parseReviewMarkdown(markdown, draft?.markdown ?? '', `${node.key}`).map((issue) => ({
              ...issue,
              sources: [node.name],
            }))
          : [],
      createdAt: now(),
    };
    w.artifacts.push(artifact);
    node.artifactId = artifact.id;
    if (isWorkflowOutputKind(kind)) w.latestDraftId = artifact.id;
    this.releaseOrHold(w, node, 'artifact.published');
  }
  /** Auto gates release immediately; manual gates stop the whole run until the author acts. */
  private releaseOrHold(w: WorkflowRun, node: WorkflowNode, type: string) {
    if (node.gate === 'manual') {
      node.status = 'awaiting_gate';
      this.wait(w, 'GATE', `「${node.name}」已完成，请查看后放行`, type);
      return;
    }
    node.status = 'released';
    this.save(w, type);
  }
  private runMerge(w: WorkflowRun, node: WorkflowNode) {
    const reviews = node.dependsOn
      .map((key) => w.nodes.find((n) => n.key === key))
      .filter((n): n is WorkflowNode => Boolean(n && n.status === 'released' && n.artifactId))
      .map((n) => this.artifact(n.artifactId, w))
      .filter((a): a is WorkflowArtifact => Boolean(a));
    const merged: ReviewIssue[] = [];
    for (const review of reviews)
      for (const issue of review.issues) {
        const same = merged.find(
          (item) =>
            item.severity === issue.severity &&
            item.quote === issue.quote &&
            item.summary === issue.summary,
        );
        if (same) same.sources = [...new Set([...same.sources, ...issue.sources])];
        else merged.push({ ...issue, id: `${node.key}:${merged.length + 1}` });
      }
    const markdown = renderIssuesMarkdown(merged);
    const artifact: WorkflowArtifact = {
      id: randomUUID(),
      workflowId: w.id,
      nodeKey: node.key,
      round: node.round,
      runId: null,
      kind: 'merge',
      markdown,
      contentHash: digest(markdown),
      inputArtifactIds: reviews.map((r) => r.id),
      createdBy: 'system',
      supersedes: null,
      issues: merged,
      createdAt: now(),
    };
    w.artifacts.push(artifact);
    node.artifactId = artifact.id;
    node.inputArtifactIds = artifact.inputArtifactIds;
    this.releaseOrHold(w, node, 'review.merged');
  }
  private adopted(w: WorkflowRun, merge: WorkflowArtifact) {
    return merge.issues.filter((issue) => effectiveAdoption(issue, w.adoption) === 'adopt');
  }
  private afterRound(w: WorkflowRun) {
    const round = this.currentRound(w);
    const merge = [...w.nodes]
      .reverse()
      .find((n) => n.stage === 'merge' && n.status === 'released' && n.round === round);
    const mergeArtifact = merge ? this.artifact(merge.artifactId, w) : undefined;
    const adopted = mergeArtifact ? this.adopted(w, mergeArtifact) : [];
    const revise = w.snapshot.template.config.steps.find((s) => s.stage === 'revise');
    if (adopted.length && mergeArtifact) {
      const outputs = w.artifacts.filter((a) => isWorkflowOutputKind(a.kind));
      const current = outputs.at(-1);
      const previous = outputs.at(-2);
      const currentNode = w.nodes.find((n) => n.key === current?.nodeKey);
      if (
        current &&
        previous &&
        currentNode?.stage === 'revise' &&
        current.markdown === previous.markdown
      ) {
        this.wait(
          w,
          'NO_CHANGE',
          '修订没有改变内容且仍有采纳的意见，请编辑稿件或调整采纳',
          'workflow.no_change',
        );
        return;
      }
      if (revise && w.snapshot.template.config.autoRevise) {
        w.revisionCount++;
        w.nodes.push(...nextRoundNodes(w.snapshot.template.config, round + 1, true));
        w.round = round + 1;
        this.save(w, 'revision.scheduled');
        const next = readyNode(w.nodes.filter((n) => n.status !== 'stale'));
        if (next) this.enqueue(w, next);
        return;
      }
      this.wait(
        w,
        'ADOPT',
        revise
          ? '仍有采纳的意见，请开启自动修订或编辑稿件后复审'
          : '仍有采纳的意见，请编辑稿件后复审',
        'workflow.awaiting_input',
      );
      return;
    }
    this.finish(w);
  }
  private finish(w: WorkflowRun) {
    const draft = this.artifact(w.latestDraftId, w);
    if (!draft) throw new AppError('VALIDATION_ERROR', '没有可保存的产物', 400);
    const task = w.snapshot.input.taskType;
    try {
      const built = buildWorkflowResult(
        task,
        w.snapshot.input,
        draft.markdown,
        basicInformationKinds,
      );
      w.result = built.result;
      w.resultWarnings = built.warnings;
      w.missingKinds = built.missing;
      w.resultError = null;
    } catch (error) {
      w.result = null;
      w.resultError = error instanceof AppError ? error.message : '产物无法解析';
      w.resultWarnings = [];
      w.missingKinds = [];
      this.wait(w, 'RESULT', `${w.resultError}。请编辑产物后继续`, 'workflow.result_invalid');
      return;
    }
    this.publish(w);
  }
  private publish(w: WorkflowRun) {
    const result = w.result;
    if (!result) throw new AppError('VALIDATION_ERROR', '没有完整产物', 400);
    w.reasonCode = null;
    if (result.type !== 'chapter_draft' || !w.targetDocumentId) {
      w.status = 'awaiting_acceptance';
      w.reason = '编排结果已准备好，请审阅后保存到对应分类';
      this.save(w, 'workflow.awaiting_acceptance');
      return;
    }
    if (!w.snapshot.input.baseVersionId)
      throw new AppError('VALIDATION_ERROR', '缺少正文基准版本', 400);
    const draft = this.artifact(w.latestDraftId, w);
    const sourceRunId =
      [...w.nodes]
        .reverse()
        .find((n) => n.runIds.length && n.status === 'released')
        ?.runIds.at(-1) ??
      draft?.runId ??
      null;
    if (!sourceRunId) throw new AppError('VALIDATION_ERROR', '缺少来源运行', 400);
    const p = this.store.insertProposal(
      {
        runId: sourceRunId,
        turnIndex: Math.max(
          0,
          Number(
            (
              this.db
                .prepare('SELECT MAX(turn_index) AS n FROM run_turns WHERE run_id=?')
                .get(sourceRunId) as { n: number }
            ).n,
          ),
        ),
        targetDocumentId: w.targetDocumentId,
        baseVersionId: w.snapshot.input.baseVersionId,
        scope: { kind: 'document' },
        content: result.content,
        reason: '协作写作最终候选；作者确认后入稿',
        citations: [],
        origin: 'candidate',
      },
      null,
    );
    w.proposalId = p.id;
    w.proposal = p;
    w.status = 'awaiting_acceptance';
    w.reason = '最终候选已准备好，请比较后接受';
    this.save(w, 'workflow.awaiting_acceptance');
  }
  private enqueue(w: WorkflowRun, node: WorkflowNode) {
    const profile = w.snapshot.profiles.find(
      (p) => p.id === node.agentVersionId,
    ) as AgentProfileVersion;
    const context = structuredClone(w.snapshot.contexts[profile.id]) as ContextPreview;
    const config = w.snapshot.template.config;
    const task = w.snapshot.input.taskType;
    const allowed = upstreamTemplateKeys(config, node.templateKey);
    const upstream: {
      id: string;
      kind: WorkflowArtifactKind;
      from: string;
      markdown: string;
      notes?: string;
    }[] = [];
    const take = (a: WorkflowArtifact | undefined, note?: string) => {
      if (a)
        upstream.push({
          id: a.id,
          kind: a.kind,
          from: a.nodeKey,
          markdown: a.markdown,
          ...(note ? { notes: note } : {}),
        });
    };
    for (const step of config.steps) {
      if (!allowed.has(step.key)) continue;
      if (['draft', 'generate', 'review', 'revise'].includes(step.stage)) continue;
      take(this.latestOf(w, step.key), w.notes[this.latestOf(w, step.key)?.id ?? '']);
    }
    const draft = this.artifact(w.latestDraftId, w);
    if (['review', 'revise'].includes(node.stage) || w.latestDraftId) {
      if (draft && node.stage !== 'plan' && node.stage !== 'analysis')
        take(draft, w.notes[draft.id]);
    }
    let adoptedIssues: ReviewIssue[] = [];
    if (node.stage === 'revise') {
      const previous = [...w.nodes]
        .reverse()
        .find((n) => n.stage === 'merge' && n.status === 'released' && n.round < node.round);
      const merge = this.artifact(previous?.artifactId ?? null, w);
      adoptedIssues = merge ? this.adopted(w, merge) : [];
    }
    node.inputArtifactIds = upstream.map((a) => a.id);
    const first = context.request.messages[0];
    const initial = JSON.parse(first?.role === 'user' ? first.content : '{}');
    context.request.messages = [
      {
        role: 'user',
        timestamp: 0,
        content: JSON.stringify({
          ...initial,
          workflowNode: { key: node.key, stage: node.stage, round: node.round },
          outputFormat: stageGuide(node, task),
          feedback: w.feedback,
          upstream,
          ...(node.stage === 'revise'
            ? {
                issuesToFix: adoptedIssues.map((issue) => ({
                  id: issue.id,
                  severity: issue.severity,
                  summary: issue.summary,
                  quote: issue.quote,
                  detail: issue.body,
                })),
              }
            : {}),
        }),
      },
    ];
    context.estimatedInputTokens = estimateTokens(context.request);
    if (context.estimatedInputTokens > context.inputLimit)
      throw new AppError(
        'CONTEXT_TOO_LARGE',
        `${node.name} 的上游稿件超出模型上下文，请调整模型或内容后重跑`,
        422,
      );
    context.hash = digest(stable(context));
    const providerConfigId = profile.config.providerConfigId ?? w.snapshot.input.providerConfigId;
    const input = writingRunInputSchema.parse({
      projectId: w.projectId,
      sessionId: null,
      purpose: 'review',
      input: w.snapshot.input.input,
      providerConfigId,
      modelId: context.request.modelId,
      context: {
        selectedVersionIds: [],
        allowedVersionIds: context.allowed.map((r) => r.versionId),
        allowSearch: profile.config.tools.includes('search_documents'),
        allowFutureOutline: w.snapshot.input.allowFutureOutline,
      },
    });
    const previousRunId = node.runIds.at(-1);
    const previous = previousRunId ? this.store.row(previousRunId) : null;
    const checkpoint = previous?.checkpoint_json
      ? decode<LoopCheckpoint>(previous.checkpoint_json)
      : null;
    const reusable =
      checkpoint &&
      checkpoint.lastTurn.response.stop === 'tool_calls' &&
      stable(checkpoint.initialRequest) === stable(context.request);
    const run = this.store.create(input, context, previousRunId ?? null, w.id);
    if (reusable && previousRunId)
      this.db
        .prepare('UPDATE runs SET checkpoint_json=? WHERE id=?')
        .run(JSON.stringify(checkpoint), run.id);
    this.db
      .prepare('INSERT INTO workflow_node_attempts VALUES(?,?,?,?,?)')
      .run(
        run.id,
        w.id,
        node.key,
        JSON.stringify({ profile, taskType: task, upstream: node.inputArtifactIds }),
        profile.id,
      );
    node.runIds.push(run.id);
    node.status = 'queued';
    node.error = null;
    w.status = 'running';
    w.reason = null;
    w.reasonCode = null;
    this.save(w, 'node.queued');
    this.writing.wake();
  }
  /** Everything downstream of an edited or re-run node is invalidated but kept as history. */
  private invalidateAfter(w: WorkflowRun, nodeKey: string) {
    const stale = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of w.nodes)
        if (
          !stale.has(n.key) &&
          n.status !== 'stale' &&
          (n.dependsOn.includes(nodeKey) || n.dependsOn.some((k) => stale.has(k)))
        ) {
          stale.add(n.key);
          changed = true;
        }
    }
    // Only results that already exist become history; unstarted nodes simply run later.
    for (const n of w.nodes)
      if (stale.has(n.key) && !['pending', 'cancelled'].includes(n.status)) n.status = 'stale';
    return stale;
  }
  private resetRound(w: WorkflowRun, round: number, withRevision = false) {
    const config = w.snapshot.template.config;
    const nodes = nextRoundNodes(config, round, withRevision);
    if (w.snapshot.input.manualGates) for (const n of nodes) n.gate = 'manual';
    w.nodes.push(...nodes);
    w.round = round;
  }
  private rejectProposal(w: WorkflowRun) {
    if (w.proposalId) this.store.reject(w.proposalId, false);
    w.proposalId = null;
    w.proposal = null;
    w.result = null;
    w.resultError = null;
    w.resultWarnings = [];
    w.missingKinds = [];
  }
  decide(id: string, decision: WorkflowDecision, key: string) {
    const result = this.store.once(`workflow:decision:${id}`, key, decision, () => {
      const w = this.get(id);
      this.library.assertRevision(w.revision, decision.expectedRevision);
      if (!held.includes(w.status)) throw new AppError('FORBIDDEN', '此流程已结束', 403);
      const activeNode = w.nodes.find(
        (n) =>
          ['queued', 'running'].includes(n.status) &&
          active(this.store.summary(n.runIds.at(-1) as string).status),
      );
      const action = decision.action;
      const gateNode = () => {
        const node = decision.nodeKey
          ? w.nodes.find((n) => n.key === decision.nodeKey)
          : w.nodes.find((n) => n.status === 'awaiting_gate');
        if (!node) throw new AppError('NOT_FOUND', '节点不存在', 404);
        return node;
      };
      if (action === 'accept_result') {
        if (w.status !== 'awaiting_acceptance' || w.proposalId)
          throw new AppError('FORBIDDEN', '当前没有可采用的通用编排结果', 403);
        if (w.sourceChanges.length && !w.sourceSnapshotAccepted)
          throw new AppError('VERSION_CONFLICT', '资料已变化，请沿用冻结资料或刷新后复审', 409);
        const complete = acceptWorkflowOutput(this.store, w, decision.itemIds);
        if (complete) {
          w.status = 'completed';
          w.outcome = 'accepted';
          w.reason = '编排结果已保存';
        } else w.reason = `已采用 ${w.acceptedResults.length} 条结果，其余候选待审阅`;
      } else if (action === 'cancel' || action === 'reject') {
        for (const n of w.nodes) {
          for (const runId of n.runIds)
            if (active(this.store.summary(runId).status)) this.writing.cancel(runId);
          if (['pending', 'queued', 'running', 'awaiting_gate'].includes(n.status))
            n.status = 'cancelled';
        }
        if (w.proposalId && ['pending', 'stale'].includes(this.store.proposal(w.proposalId).status))
          this.store.reject(w.proposalId);
        w.status = action === 'reject' ? 'completed' : 'cancelled';
        w.outcome = action === 'reject' ? 'rejected' : null;
        w.reasonCode = null;
      } else if (action === 'pause') {
        if (!['queued', 'running'].includes(w.status))
          throw new AppError('FORBIDDEN', '只有运行中的流程可以暂停', 403);
        w.pauseRequested = true;
      } else if (action === 'set_adoption') {
        if (!decision.issueId || !decision.adoption)
          throw new AppError('VALIDATION_ERROR', '请指定意见与处理方式', 400);
        const issue = w.artifacts
          .filter((a) => a.kind === 'merge')
          .flatMap((a) => a.issues)
          .find((item) => item.id === decision.issueId);
        if (!issue) throw new AppError('NOT_FOUND', '意见不存在', 404);
        if (issue.severity === 'P0' && decision.adoption === 'ignore' && !decision.reason?.trim())
          throw new AppError('VALIDATION_ERROR', '忽略 P0 意见需要填写理由', 400);
        w.adoption[issue.id] = {
          decision: decision.adoption,
          reason: decision.reason?.trim() ?? '',
        };
        w.feedback = decision.feedback || w.feedback;
        this.db
          .prepare('INSERT INTO workflow_decisions VALUES(?,?,?,?,?)')
          .run(randomUUID(), id, w.revision, JSON.stringify(decision), now());
        this.save(w, 'decision.set_adoption');
        return w;
      } else {
        if (activeNode) throw new AppError('PROJECT_BUSY', '请先等待当前节点结束', 409);
        if (action === 'release') {
          if (w.status !== 'awaiting_input' || w.reasonCode !== 'GATE')
            throw new AppError('FORBIDDEN', '当前没有等待放行的节点', 403);
          const node = gateNode();
          if (node.status !== 'awaiting_gate')
            throw new AppError('FORBIDDEN', '该节点不在等待放行状态', 403);
          if (decision.feedback.trim() && node.artifactId)
            w.notes[node.artifactId] = decision.feedback.trim();
          node.status = 'released';
        } else if (action === 'edit_artifact') {
          if (!decision.content?.trim() || !decision.nodeKey)
            throw new AppError('VALIDATION_ERROR', '请提供节点与完整产物内容', 400);
          if (w.acceptedResults.length)
            throw new AppError('FORBIDDEN', '已有结果被采用，请新建任务修改正式资料', 403);
          if (!['awaiting_input', 'awaiting_acceptance', 'paused'].includes(w.status))
            throw new AppError('FORBIDDEN', '请在流程暂停或等待处理时编辑产物', 403);
          const node = w.nodes.find((n) => n.key === decision.nodeKey);
          const old = this.artifact(node?.artifactId ?? null, w);
          if (!node || !old) throw new AppError('NOT_FOUND', '节点产物不存在', 404);
          this.rejectProposal(w);
          const draft = this.artifact(w.latestDraftId, w);
          const markdown = decision.content;
          const artifact: WorkflowArtifact = {
            ...old,
            id: randomUUID(),
            markdown,
            contentHash: digest(markdown),
            createdBy: 'author',
            supersedes: old.id,
            issues:
              old.kind === 'review'
                ? parseReviewMarkdown(markdown, draft?.markdown ?? '', node.key).map((i) => ({
                    ...i,
                    sources: [node.name],
                  }))
                : old.issues,
            createdAt: now(),
          };
          w.artifacts.push(artifact);
          node.artifactId = artifact.id;
          if (isWorkflowOutputKind(artifact.kind) && w.latestDraftId === old.id)
            w.latestDraftId = artifact.id;
          const outputEdited = isWorkflowOutputKind(artifact.kind);
          this.invalidateAfter(w, node.key);
          if (outputEdited) {
            // Reviewers consumed the old draft; re-run them as a new round on the edited draft.
            for (const n of w.nodes)
              if (n.stage === 'review' || n.stage === 'merge')
                if (n.status !== 'stale') n.status = 'stale';
            this.resetRound(w, this.currentRound(w) + 1);
          }
          w.adoption = {};
          if (node.status === 'awaiting_gate') {
            // An edit does not release the gate; the author still decides when to continue.
            w.feedback = decision.feedback || w.feedback;
            this.db
              .prepare('INSERT INTO workflow_decisions VALUES(?,?,?,?,?)')
              .run(randomUUID(), id, w.revision, JSON.stringify(decision), now());
            this.save(w, 'decision.edit_artifact');
            return w;
          }
        } else if (action === 'rerun_missing') {
          // Author-triggered only: the engine never loops on missing categories by itself.
          if (w.status !== 'awaiting_acceptance' || !w.missingKinds.length)
            throw new AppError('FORBIDDEN', '当前没有缺失的分类', 403);
          if (w.acceptedResults.length)
            throw new AppError('FORBIDDEN', '已有结果被采用，请新建任务补充缺失分类', 403);
          const node = [...w.nodes]
            .reverse()
            .find((n) => ['draft', 'generate'].includes(n.stage) && n.status === 'released');
          if (!node) throw new AppError('NOT_FOUND', '找不到生成节点', 404);
          const labels = w.missingKinds
            .map((kind) => elementLabels[kind as keyof typeof elementLabels] ?? kind)
            .join('、');
          w.feedback =
            `${w.feedback}\n上一版缺少这些分类：${labels}。请输出包含上一版全部条目以及缺失分类的完整结果。`.trim();
          this.rejectProposal(w);
          node.status = 'pending';
          node.artifactId = null;
          node.error = null;
          this.invalidateAfter(w, node.key);
          for (const n of w.nodes.filter((x) => x.stage === 'merge' && x.status !== 'stale'))
            n.status = 'stale';
          this.resetRound(w, this.currentRound(w) + 1);
          // The new round's reviewers depend on the regenerated draft.
          for (const n of w.nodes.filter((x) => x.round === w.round && x.stage === 'review'))
            n.dependsOn = [node.key];
        } else if (action === 'rerun') {
          if (!['awaiting_input', 'paused', 'failed', 'limited', 'interrupted'].includes(w.status))
            throw new AppError('FORBIDDEN', '当前状态无法重跑节点', 403);
          const node = gateNode();
          if (node.stage === 'merge')
            throw new AppError('FORBIDDEN', '审校汇总由系统生成，请重跑审校节点', 403);
          this.rejectProposal(w);
          node.status = 'pending';
          node.artifactId = null;
          node.error = null;
          this.invalidateAfter(w, node.key);
          for (const n of w.nodes.filter(
            (x) => x.stage === 'merge' && x.dependsOn.includes(node.key),
          ))
            n.status = 'pending';
        } else if (action === 'use_candidate') {
          if (w.status !== 'awaiting_input' || !w.latestDraftId)
            throw new AppError('FORBIDDEN', '当前没有可选择的最终候选', 403);
          if (w.nodes.some((n) => !['released', 'skipped', 'stale'].includes(n.status)))
            throw new AppError('FORBIDDEN', '请先完成剩余必需节点', 403);
          this.finish(w);
          this.db
            .prepare('INSERT INTO workflow_decisions VALUES(?,?,?,?,?)')
            .run(randomUUID(), id, w.revision, JSON.stringify(decision), now());
          this.save(w, `decision.${action}`);
          return w;
        } else if (action === 'use_snapshot') {
          if (!['awaiting_input', 'awaiting_acceptance', 'paused'].includes(w.status))
            throw new AppError('FORBIDDEN', '请在流程暂停或等待确认时选择资料策略', 403);
          w.sourceSnapshotAccepted = true;
        } else if (action === 'retry' || action === 'resume') {
          if (!['failed', 'limited', 'interrupted', 'paused'].includes(w.status))
            throw new AppError('FORBIDDEN', '当前状态无需恢复或重试', 403);
          const n = w.nodes.find((n) => ['failed', 'limited', 'interrupted'].includes(n.status));
          if (n) {
            n.status = 'pending';
            n.error = null;
          }
        } else if (action === 'continue') {
          if (w.status !== 'awaiting_input') throw new AppError('FORBIDDEN', '当前无需处理', 403);
          if (w.reasonCode === 'RESULT') {
            this.finish(w);
            if (w.status === 'awaiting_input') {
              this.save(w, 'decision.continue');
              return w;
            }
          } else {
            if (w.reasonCode === 'NO_CHANGE' && !decision.feedback.trim())
              throw new AppError('VALIDATION_ERROR', '修订没有变化，请补充意见后继续', 400);
            if (!w.latestDraftId) throw new AppError('FORBIDDEN', '没有可复审的稿件', 403);
            // Another review round on the current draft; with feedback the revise node runs first.
            const revise = w.snapshot.template.config.steps.some((s) => s.stage === 'revise');
            const withRevision = revise && Boolean(decision.feedback.trim());
            if (withRevision) w.revisionCount++;
            this.resetRound(w, this.currentRound(w) + 1, withRevision);
          }
        } else throw new AppError('FORBIDDEN', '此操作暂不支持，请结束后基于最新资料新建流程', 403);
        if (!['use_snapshot'].includes(action)) {
          w.status = 'queued';
          w.reason = null;
          w.reasonCode = null;
          w.pauseRequested = false;
        }
      }
      w.feedback = decision.feedback || w.feedback;
      this.db
        .prepare('INSERT INTO workflow_decisions VALUES(?,?,?,?,?)')
        .run(randomUUID(), id, w.revision, JSON.stringify(decision), now());
      this.save(w, `decision.${action}`);
      return w;
    });
    void this.pump();
    return result;
  }
  binding(runId: string) {
    return this.db.prepare('SELECT * FROM workflow_node_attempts WHERE run_id=?').get(runId) as
      | Row
      | undefined;
  }
  async refreshSources(id: string, revision: number, content: string | undefined, key: string) {
    const request = { revision, content: content ?? null };
    const old = this.store.prior<WorkflowRun>(`workflow:refresh:${id}`, key, request);
    if (old) return this.get(id);
    const w = this.get(id);
    this.library.assertRevision(w.revision, revision);
    if (!['awaiting_input', 'awaiting_acceptance', 'paused'].includes(w.status) || !w.latestDraftId)
      throw new AppError('FORBIDDEN', '请先完成生成并等待流程暂停', 403);
    if (w.acceptedResults.length)
      throw new AppError('FORBIDDEN', '已有部分结果被采用，请新建任务使用最新资料', 403);
    if (w.snapshot.input.taskType === 'basic_information') {
      for (const reference of w.snapshot.input.elementTargets ?? []) {
        const current = this.store.novels.getDocument(reference.documentId);
        if (current.version.id !== reference.baseVersionId)
          throw new AppError(
            'VERSION_CONFLICT',
            '基础信息条目已变化，请结束当前编排并基于最新资料重新运行',
            409,
          );
      }
    }
    const target = w.targetDocumentId ? this.store.novels.getDocument(w.targetDocumentId) : null;
    if (target && target.version.id !== w.snapshot.input.baseVersionId && !content?.trim())
      throw new AppError('VERSION_CONFLICT', '正文已有变化，请先比较并填写合并后的完整稿', 409);
    const currentVersion = (versionId: string) => {
      const ref = Object.values(w.snapshot.contexts)
        .flatMap((p) => p.allowed)
        .find((r) => r.versionId === versionId);
      return ref
        ? this.store.novels.getDocument(ref.documentId).document.currentVersionId
        : versionId;
    };
    const input = {
      ...w.snapshot.input,
      baseVersionId: target?.version.id ?? null,
      selectedVersionIds: w.snapshot.input.selectedVersionIds.map(currentVersion),
      // Explicitly refreshing sources authorizes the latest versions of the
      // already granted documents, including an author's newer draft.
      allowedVersionIds: [
        ...new Set(
          Object.values(w.snapshot.contexts)
            .flatMap((p) => p.allowed)
            .map((ref) => currentVersion(ref.versionId)),
        ),
      ],
    };
    const fresh = await this.preview(input);
    // Refreshing sources must not silently upgrade the model, parameters, tools or global prompt:
    // those stay as frozen when the run started, only the authorized material changes.
    const snapshot = workflowPreviewSchema.parse({
      ...fresh,
      contexts: Object.fromEntries(
        Object.entries(fresh.contexts).map(([profileId, context]) => {
          const frozen = w.snapshot.contexts[profileId];
          if (!frozen) return [profileId, context];
          return [
            profileId,
            {
              ...context,
              agentPromptRevision: frozen.agentPromptRevision,
              request: {
                ...context.request,
                systemPrompt: frozen.request.systemPrompt,
                modelId: frozen.request.modelId,
                connectionSnapshot: frozen.request.connectionSnapshot,
                parameters: frozen.request.parameters,
                toolDefinitions: frozen.request.toolDefinitions,
              },
            },
          ];
        }),
      ),
      profiles: w.snapshot.profiles,
      hash: fresh.hash,
    });
    const result = this.store.once(`workflow:refresh:${id}`, key, request, () => {
      const latest = this.get(id);
      this.library.assertRevision(latest.revision, revision);
      this.rejectProposal(latest);
      const draft = this.artifact(latest.latestDraftId, latest);
      if (!draft) throw new AppError('VALIDATION_ERROR', '缺少完整候选', 400);
      if (content?.trim()) {
        const merged: WorkflowArtifact = {
          ...draft,
          id: randomUUID(),
          markdown: content,
          contentHash: digest(content),
          createdBy: 'author',
          supersedes: draft.id,
          createdAt: now(),
        };
        latest.artifacts.push(merged);
        latest.latestDraftId = merged.id;
      }
      latest.sourceHistory.push(latest.snapshot);
      latest.snapshot = snapshot;
      latest.sourceSnapshotAccepted = false;
      for (const n of latest.nodes)
        if (['review', 'merge'].includes(n.stage) && n.status !== 'stale') n.status = 'stale';
      latest.adoption = {};
      this.resetRound(latest, this.currentRound(latest) + 1);
      latest.status = 'queued';
      latest.reason = null;
      latest.reasonCode = null;
      this.save(latest, 'sources.refreshed');
      return latest;
    });
    void this.pump();
    return result;
  }
  private executionElapsed(runId: string, until: string) {
    const row = this.db
      .prepare(
        "SELECT payload_json FROM run_events WHERE run_id=? AND type='run.started' ORDER BY seq LIMIT 1",
      )
      .get(runId) as Row | undefined;
    const started = row ? decode<{ startedAt: string }>(row.payload_json).startedAt : null;
    return started ? Math.max(0, Date.parse(until) - Date.parse(started)) : 0;
  }
  reserveCall(runId: string) {
    const b = this.binding(runId);
    if (!b?.workflow_id) return;
    this.store.database.transaction(() => {
      const w = this.get(String(b.workflow_id));
      if (!['running', 'queued'].includes(w.status)) throw new LoopStop('cancelled');
      w.modelCalls++;
      this.save(w, 'model.requested');
    });
  }
  registry(runId: string): ActionRegistry {
    const b = this.binding(runId);
    if (!b) throw new AppError('NOT_FOUND', '节点绑定不存在', 404);
    const binding = decode<{ profile: AgentProfileVersion }>(b.context_json);
    const assertActive = () => {
      if (b.workflow_id && !['running', 'queued'].includes(this.get(String(b.workflow_id)).status))
        throw new LoopStop('cancelled');
    };
    // Nodes only read; their final reply is the Markdown artifact.
    const base = actualActions(this.store, runId, this.skills);
    const handlers: ActionHandlers = {};
    for (const name of binding.profile.config.tools)
      if (base.names.includes(name))
        handlers[name] = async (args, ctx) => {
          assertActive();
          const result = await base.execute(
            { id: randomUUID(), name, arguments: jsonSchema.parse(args) },
            ctx,
          );
          if (!result.ok) throw new ActionError(result.error.code, result.error.message);
          return result.value as never;
        };
    return new ActionRegistry(handlers);
  }
  async close() {
    this.stopped = true;
    await this.pumping;
  }
}
