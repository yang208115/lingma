import { randomUUID } from 'node:crypto';
import {
  AgentError,
  MemoryLoopRecorder,
  type ModelAdapter,
  type ModelRequest,
  runLoop,
} from '@lingma/agent';
import {
  actionToolDefinition,
  type ContextPreview,
  connectionCheckSchema,
  jsonSchema,
  type LoopCheckpoint,
  type WritingRunInput,
  writingRunInputSchema,
} from '@lingma/shared';
import type { WorkbenchDatabase } from '../db/database.js';
import { ElementService } from '../elements/service.js';
import { AppError } from '../errors.js';
import type { NovelService } from '../services/novels.js';
import type { SkillService } from '../services/skills.js';
import { WorkflowService } from '../workflows/service.js';
import { actualActions } from './actions.js';
import { ContextService, digest, stable } from './context.js';
import { estimateTokens } from './estimate.js';
import { AgentPromptService } from './prompt.js';
import { ProviderService } from './providers.js';
import { SqlLoopRecorder } from './recorder.js';
import { active, decode, emptyUsage, now, type Row, WritingStore } from './store.js';

export class WritingService {
  readonly elements: ElementService;
  readonly workflows: WorkflowService;
  readonly store: WritingStore;
  readonly providers: ProviderService;
  readonly prompt: AgentPromptService;
  private readonly context: ContextService;
  private task: { id: string; controller: AbortController; promise: Promise<void> } | undefined;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private checking = false;
  private checkController: AbortController | undefined;
  private checkDone: Promise<void> | undefined;
  private readonly streams = new Set<() => void>();
  constructor(
    database: WorkbenchDatabase,
    novels: NovelService,
    private readonly skills: SkillService,
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      fetch?: typeof fetch;
      adapterFactory?: (request: ModelRequest) => ModelAdapter;
      /** Called when a background pump fails; the failure is otherwise only visible in task state. */
      onBackgroundError?: (error: unknown) => void;
    } = {},
  ) {
    this.store = new WritingStore(database, novels);
    this.providers = new ProviderService(database, options.env, options.fetch);
    this.prompt = new AgentPromptService(database);
    this.context = new ContextService(novels, skills, this.providers, this.prompt);
    this.store.recover();
    this.workflows = new WorkflowService(this, skills);
    this.elements = new ElementService(this);
    this.schedule();
  }
  async preview(raw: WritingRunInput, options?: Parameters<ContextService['prepare']>[1]) {
    const input = writingRunInputSchema.parse(raw);
    this.store.assertSession(input);
    return this.context.prepare(input, options);
  }
  async create(raw: WritingRunInput, key: string) {
    const input = writingRunInputSchema.parse(raw);
    const old = this.store.prior<ReturnType<WritingStore['summary']>>('run:create', key, input);
    if (old) return old;
    if (this.stopped) throw new AppError('MAINTENANCE_MODE', '运行管理器正在关闭', 503);
    const preview = await this.preview(input);
    if (input.expectedContextHash && input.expectedContextHash !== preview.hash)
      throw new AppError('VERSION_CONFLICT', '上下文已变化，请重新预览', 409);
    const result = this.store.once(
      'run:create',
      key,
      input,
      () => {
        if (this.prompt.get().revision !== preview.agentPromptRevision)
          throw new AppError('VERSION_CONFLICT', 'Agent 提示词已变化，请重新预览', 409);
        const config = this.providers.get(input.providerConfigId).config;
        if (
          stable(config.connection) !== stable(preview.request.connectionSnapshot) ||
          stable(config.parameters) !== stable(preview.request.parameters)
        )
          throw new AppError('VERSION_CONFLICT', '模型设置已变化，请重新预览', 409);
        return this.store.create(input, preview);
      },
      202,
    );
    this.schedule();
    return result;
  }
  retry(id: string, key: string) {
    if (this.elements.binding(id)) throw new AppError('FORBIDDEN', '请从基本信息面板重试任务', 403);
    if (this.workflows.binding(id)) throw new AppError('FORBIDDEN', '请从工作流重试节点', 403);
    if (this.stopped) throw new AppError('MAINTENANCE_MODE', '运行管理器正在关闭', 503);
    const result = this.store.once(
      `retry:${id}`,
      key,
      {},
      () => {
        const row = this.store.row(id);
        if (active(row.status) || row.status === 'completed')
          throw new AppError('FORBIDDEN', '只有未成功的终态运行可以重试', 403);
        if (
          row.checkpoint_json &&
          decode<LoopCheckpoint>(row.checkpoint_json).lastTurn.response.stop === 'complete'
        )
          throw new AppError('FORBIDDEN', '已有完整最终候选，请查看原结果或新建任务', 403);
        const input = decode<WritingRunInput>(row.input_json),
          preview = decode<ContextPreview>(row.snapshot_json);
        const checkpoint = row.checkpoint_json ? decode<LoopCheckpoint>(row.checkpoint_json) : null;
        const proposalDefinition = jsonSchema.parse(
          actionToolDefinition('propose_document_change'),
        );
        const chapterCreationDefinition = jsonSchema.parse(
          actionToolDefinition('propose_chapter_creation'),
        );
        const upgradedTools = preview.request.toolDefinitions.map((tool) => {
          if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
          if (tool.name === 'propose_document_change') return proposalDefinition;
          if (tool.name === 'propose_chapter_creation') return chapterCreationDefinition;
          return tool;
        });
        if (stable(upgradedTools) !== stable(preview.request.toolDefinitions)) {
          preview.request.toolDefinitions = upgradedTools;
          preview.estimatedInputTokens = estimateTokens(preview.request);
          preview.hash = digest(
            stable(
              Object.fromEntries(Object.entries(preview).filter(([field]) => field !== 'hash')),
            ),
          );
          // Upgrade the new retry's contract while keeping the original run and committed history intact.
          if (checkpoint) checkpoint.initialRequest = structuredClone(preview.request);
        }
        const next = this.store.create(input, preview, id);
        if (checkpoint)
          this.store.db
            .prepare('UPDATE runs SET checkpoint_json=? WHERE id=?')
            .run(JSON.stringify(checkpoint), next.id);
        for (const citation of this.store.db
          .prepare(
            "SELECT c.entry_json FROM run_context_entries c WHERE c.run_id=? AND (c.turn_index=-1 OR EXISTS(SELECT 1 FROM run_turns t WHERE t.run_id=c.run_id AND t.turn_index=c.turn_index AND t.status='complete'))",
          )
          .all(id) as Row[])
          this.store.citation(next.id, -1, decode(citation.entry_json));
        return next;
      },
      202,
    );
    this.schedule();
    return result;
  }
  cancel(id: string) {
    const result = this.store.database.transaction((db) => {
      const row = this.store.row(id);
      if (row.status === 'queued')
        this.store.terminal(id, 'cancelled', 'cancelled', decode(row.usage_json), null);
      else if (row.status === 'running')
        db.prepare("UPDATE runs SET status='cancelling',cancel_requested_at=? WHERE id=?").run(
          now(),
          id,
        );
      return this.store.summary(id);
    });
    if (this.task?.id === id && active(result.status)) this.task.controller.abort();
    return result;
  }
  attachStream(close: () => void) {
    this.streams.add(close);
    return () => this.streams.delete(close);
  }
  wake() {
    this.schedule();
  }
  private schedule(delay = 0) {
    if (this.scheduled || this.stopped) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.pump();
    }, delay);
  }
  private pump() {
    if (this.stopped || this.task || this.checking || !this.store.database.ready()) return;
    const row = this.store.db
      .prepare("SELECT id FROM runs WHERE status='queued' ORDER BY created_at,id LIMIT 1")
      .get() as { id: string } | undefined;
    if (!row) {
      void this.elements.pump().catch((error: unknown) => this.options.onBackgroundError?.(error));
      return;
    }
    try {
      this.store.database.transaction((db) =>
        db.prepare("UPDATE runs SET status='running' WHERE id=? AND status='queued'").run(row.id),
      );
    } catch {
      this.schedule(250);
      return;
    }
    const controller = new AbortController();
    const promise = this.execute(row.id, controller).finally(() => {
      this.task = undefined;
      void this.elements
        .pump()
        .then(() => this.workflows.pump())
        .finally(() => this.schedule());
    });
    this.task = { id: row.id, controller, promise };
  }
  private async execute(id: string, controller: AbortController) {
    const recorder = new SqlLoopRecorder(this.store, id, () => controller.abort());
    try {
      const row = this.store.row(id),
        preview = decode<ContextPreview>(row.snapshot_json);
      const adapter = this.options.adapterFactory?.(preview.request) ?? this.providers.adapter();
      const boundedAdapter: ModelAdapter = {
        id: adapter.id,
        validateRequest: (request) => adapter.validateRequest?.(request),
        async *stream(request, signal) {
          // Count every adapter request before contacting a provider, including failed attempts.
          service.workflows.reserveCall(id);
          if (estimateTokens(request) > preview.inputLimit)
            throw new AgentError('CONTEXT_TOO_LARGE');
          yield* adapter.stream(request, signal);
        },
      };
      const service = this;
      const result = await runLoop({
        runId: id,
        adapter: boundedAdapter,
        registry: this.workflows.binding(id)
          ? this.workflows.registry(id)
          : actualActions(this.store, id, this.skills),
        request: preview.request,
        recorder,
        signal: controller.signal,
        ...(row.checkpoint_json ? { checkpoint: decode<LoopCheckpoint>(row.checkpoint_json) } : {}),
      });
      if (result.recordingFailed)
        this.store.database.transaction(() =>
          this.store.terminal(id, 'failed', 'STORAGE_ERROR', result.usage, result.output),
        );
    } catch (error) {
      try {
        const row = this.store.row(id);
        this.store.database.transaction(() =>
          this.store.terminal(
            id,
            'failed',
            error instanceof AgentError || error instanceof AppError
              ? error.code
              : 'INTERNAL_ERROR',
            decode(row.usage_json),
            row.output_json ? decode(row.output_json) : null,
          ),
        );
      } catch {
        /* A storage outage leaves a non-terminal row for startup recovery. */
      }
    } finally {
      recorder.dispose();
    }
  }
  async checkProvider(id: string) {
    if (
      this.task ||
      this.checking ||
      this.stopped ||
      this.store.db.prepare("SELECT id FROM runs WHERE status='queued' LIMIT 1").get()
    )
      throw new AppError('PROJECT_BUSY', '请等待运行结束后检查连接', 409);
    const provider = this.providers.get(id);
    this.checking = true;
    this.checkController = new AbortController();
    let settle: () => void = () => {};
    this.checkDone = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      const result = await runLoop({
        runId: randomUUID(),
        adapter: this.providers.adapter(),
        registry: new (await import('@lingma/agent')).ActionRegistry({}),
        request: {
          connectionSnapshot: provider.config.connection,
          modelId: provider.config.modelId,
          systemPrompt: '连接检查。只回答 OK。',
          messages: [{ role: 'user', content: 'OK', timestamp: 0 }],
          parameters: { maxTokens: Math.min(16, provider.config.connection.maxOutputTokens) },
          toolDefinitions: [],
        },
        recorder: new MemoryLoopRecorder(),
        signal: this.checkController.signal,
      });
      const check = connectionCheckSchema.parse({
        id: randomUUID(),
        providerId: id,
        modelId: provider.config.modelId,
        status: result.status,
        stopReason: result.stopReason,
        usage: { known: result.usage.known, complete: result.usage.complete },
        createdAt: now(),
      });
      this.store.database.transaction((db) =>
        db
          .prepare(
            'INSERT INTO provider_checks(id,provider_id,result_json,created_at) VALUES(?,?,?,?)',
          )
          .run(check.id, id, JSON.stringify(check), check.createdAt),
      );
      return check;
    } finally {
      this.checking = false;
      this.checkController = undefined;
      settle();
      this.checkDone = undefined;
      this.schedule();
    }
  }
  checks(id: string) {
    this.providers.get(id);
    return (
      this.store.db
        .prepare(
          'SELECT result_json FROM provider_checks WHERE provider_id=? ORDER BY created_at DESC LIMIT 50',
        )
        .all(id) as Row[]
    ).map((row) => connectionCheckSchema.parse(decode(row.result_json)));
  }
  async close() {
    this.stopped = true;
    await this.elements.close();
    await this.workflows.close();
    clearTimeout(this.scheduled);
    for (const close of this.streams) close();
    this.streams.clear();
    this.checkController?.abort();
    await this.checkDone;
    if (this.task) {
      this.cancel(this.task.id);
      await this.task.promise;
    }
    if (!this.store.db.open) return;
    this.store.database.transaction(() => {
      for (const row of this.store.db
        .prepare("SELECT id FROM runs WHERE status='queued'")
        .all() as { id: string }[])
        this.store.terminal(row.id, 'cancelled', 'cancelled', emptyUsage, null);
    });
  }
}
