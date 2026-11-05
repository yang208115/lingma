import { randomUUID } from 'node:crypto';
import { AgentError, type LoopResult } from '@lingma/agent';
import {
  type ContextEntry,
  type ContextPreview,
  isElementKind,
  isStoryEventKind,
  normalizeOutlineMarkdown,
  type Proposal,
  proposalSchema,
  type RunEvent,
  readElementData,
  runDetailSchema,
  runEventSchema,
  runSummarySchema,
  sessionHistorySchema,
  sessionSchema,
  visibleWritingTask,
  type WorkflowRun,
  type WritingRunInput,
} from '@lingma/shared';
import type { WorkbenchDatabase } from '../db/database.js';
import { AppError } from '../errors.js';
import type { NovelService } from '../services/novels.js';
import { canPropose, digest, stable } from './context.js';
import { listOutlineProposals } from './outlines.js';
import { assertRunWriteMode, isWorkflowProposal } from './write-mode.js';

export type Row = Record<string, unknown>;
export const now = () => new Date().toISOString();
export const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
export const active = (status: unknown) =>
  ['queued', 'running', 'cancelling'].includes(String(status));
export const emptyUsage = {
  known: { inputTokens: null, outputTokens: null, cost: null },
  complete: false,
};
export class WritingStore {
  constructor(
    readonly database: WorkbenchDatabase,
    readonly novels: NovelService,
  ) {}
  get db(): WorkbenchDatabase['connection'] {
    return this.database.connection;
  }
  row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new AppError('NOT_FOUND', '运行不存在', 404);
    return row;
  }
  summary(id: string) {
    const row = this.row(id);
    const task = decode<{ input?: string }>(row.input_json).input ?? '';
    return runSummarySchema.parse({
      id: row.id,
      taskPreview: visibleWritingTask(task).slice(0, 240),
      projectId: row.project_id,
      sessionId: row.session_id,
      purpose: row.purpose,
      status: row.status,
      stopReason: row.stop_reason,
      retryOfRunId: row.retry_of_run_id,
      lastEventSeq: row.last_event_seq,
      eventFloor: row.event_floor,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      usage: {
        known: decode<typeof emptyUsage>(row.usage_json).known,
        complete: decode<typeof emptyUsage>(row.usage_json).complete,
      },
      output: row.output_json ? decode(row.output_json) : null,
    });
  }
  detail(id: string) {
    return this.db.transaction(() => {
      const row = this.row(id);
      return runDetailSchema.parse({
        ...this.summary(id),
        input: decode(row.input_json),
        preview: decode(row.snapshot_json),
        usageDetails: decode(row.usage_json),
        turns: (
          this.db
            .prepare('SELECT * FROM run_turns WHERE run_id=? ORDER BY turn_index')
            .all(id) as Row[]
        ).map((turn) => ({
          turnIndex: turn.turn_index,
          status: turn.status,
          partialText: turn.partial_text,
          thinking: turn.thinking,
          request: turn.request_json ? decode(turn.request_json) : null,
          response: turn.response_json ? decode(turn.response_json) : null,
        })),
        tools: (
          this.db
            .prepare('SELECT * FROM tool_executions WHERE run_id=? ORDER BY rowid')
            .all(id) as Row[]
        ).map((tool) => ({
          id: tool.id,
          turnIndex: tool.turn_index,
          callId: tool.call_id,
          name: tool.name,
          args: tool.args_json ? decode(tool.args_json) : null,
          result: tool.result_json ? decode(tool.result_json) : null,
        })),
        contexts: (
          this.db
            .prepare('SELECT entry_json FROM run_context_entries WHERE run_id=? ORDER BY id')
            .all(id) as Row[]
        ).map((row) => decode(row.entry_json)),
        trace: (
          this.db
            .prepare(
              "SELECT seq,type,payload_json,created_at FROM run_events WHERE run_id=? AND type IN ('run.started','turn.started','model.retry','turn.completed','tool.started','tool.completed','run.finished') ORDER BY seq",
            )
            .all(id) as Row[]
        ).map((event) => {
          const payload = decode<{
            turnIndex?: number;
            executionId?: string;
            attempt?: number;
            maxRetries?: number;
          }>(event.payload_json);
          return {
            seq: event.seq,
            type: event.type,
            turnIndex: payload.turnIndex ?? null,
            executionId: payload.executionId ?? null,
            retryAttempt: payload.attempt ?? null,
            maxRetries: payload.maxRetries ?? null,
            createdAt: event.created_at,
          };
        }),
        proposals: this.proposals(id),
        outlineProposals: listOutlineProposals(this, id),
      });
    })();
  }
  list(projectId: string | undefined, limit: number, cursor?: string, sessionId?: string) {
    const boundary = cursor ? this.row(cursor) : null;
    const rows = this.db
      .prepare(
        'SELECT id FROM runs WHERE (? IS NULL OR project_id=?) AND (? IS NULL OR session_id=?) AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?',
      )
      .all(
        projectId ?? null,
        projectId ?? null,
        sessionId ?? null,
        sessionId ?? null,
        boundary?.created_at ?? '~',
        boundary?.created_at ?? '~',
        cursor ?? '~',
        limit + 1,
      ) as { id: string }[];
    return {
      data: rows.slice(0, limit).map((row) => this.summary(row.id)),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
    };
  }
  prior<T>(scope: string, key: string, request: unknown): T | undefined {
    const row = this.db
      .prepare('SELECT * FROM idempotency_keys WHERE scope=? AND key=?')
      .get(scope, key) as Row | undefined;
    if (!row) return undefined;
    if (row.request_hash !== digest(stable(request)))
      throw new AppError('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同请求', 409);
    return decode<T>(row.response_json);
  }
  once<T>(scope: string, key: string, request: unknown, action: () => T, status = 200): T {
    return this.database.transaction((db) => {
      const old = this.prior<T>(scope, key, request);
      if (old !== undefined) return { value: old };
      const result = action();
      if (result && typeof result === 'object' && 'then' in result)
        throw new AppError('INTERNAL_ERROR', '幂等事务必须同步完成', 500);
      db.prepare(
        'INSERT INTO idempotency_keys(scope,key,request_hash,status_code,response_json,created_at) VALUES(?,?,?,?,?,?)',
      ).run(scope, key, digest(stable(request)), status, JSON.stringify(result), now());
      return { value: result };
    }).value;
  }
  session(projectId: string, chapterId: string | null, title: string) {
    this.novels.getProject(projectId);
    if (chapterId) {
      const doc = this.novels.getDocument(chapterId).document;
      if (doc.projectId !== projectId || doc.kind !== 'chapter')
        throw new AppError('FORBIDDEN', '会话章节不属于作品', 403);
    }
    return this.database.transaction((db) => {
      const result = { id: randomUUID(), projectId, chapterId, title, createdAt: now() };
      db.prepare(
        'INSERT INTO sessions(id,project_id,chapter_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      ).run(result.id, projectId, chapterId, title, result.createdAt, result.createdAt);
      return sessionSchema.parse(result);
    });
  }
  sessionDetail(id: string, includeDeleted = false) {
    const row = this.db
      .prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM messages WHERE session_id=s.id) AS message_count,
      ((SELECT COUNT(*) FROM runs WHERE session_id=s.id) +
        (SELECT COUNT(*) FROM workflow_runs WHERE json_extract(state_json,'$.snapshot.input.sessionId')=s.id)) AS run_count,
      (SELECT id FROM runs WHERE session_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_run_id,
      (SELECT status FROM runs WHERE session_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) AS latest_run_status,
      (SELECT CASE WHEN (content LIKE '当前是作品大纲规划。%' OR content LIKE '当前是故事大纲与时间线规划。%') AND instr(content,char(10)||char(10))>0
        THEN substr(content,instr(content,char(10)||char(10))+2,240) ELSE substr(content,1,240) END
        FROM messages WHERE session_id=s.id ORDER BY rowid DESC LIMIT 1) AS preview
      ,(SELECT substr(json_extract(state_json,'$.snapshot.input.input'),1,240) FROM workflow_runs
        WHERE json_extract(state_json,'$.snapshot.input.sessionId')=s.id
        AND created_at>=COALESCE((SELECT MAX(created_at) FROM messages WHERE session_id=s.id),'')
        ORDER BY created_at DESC,id DESC LIMIT 1) AS workflow_preview
      FROM sessions s WHERE s.id=?`)
      .get(id) as Row | undefined;
    if (!row || (!includeDeleted && row.deleted_at))
      throw new AppError('NOT_FOUND', '对话不存在或已移入回收站', 404);
    this.novels.getProject(String(row.project_id));
    return sessionHistorySchema.parse({
      id: row.id,
      projectId: row.project_id,
      chapterId: row.chapter_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      deletedAt: row.deleted_at,
      preview: visibleWritingTask(String(row.workflow_preview ?? row.preview ?? '')),
      messageCount: row.message_count,
      runCount: row.run_count,
      latestRunId: row.latest_run_id,
      latestRunStatus: row.latest_run_status,
    });
  }
  renameSession(id: string, title: string) {
    return this.database.transaction(() => {
      this.sessionDetail(id);
      this.db.prepare('UPDATE sessions SET title=? WHERE id=?').run(title, id);
      return this.sessionDetail(id);
    });
  }
  deleteSession(id: string) {
    return this.database.transaction(() => {
      const item = this.sessionDetail(id, true);
      if (item.deletedAt) return item;
      if (
        this.db
          .prepare(
            "SELECT id FROM runs WHERE session_id=? AND status IN ('queued','running','cancelling')",
          )
          .get(id) ||
        this.db
          .prepare(
            "SELECT id FROM workflow_runs WHERE json_extract(state_json,'$.snapshot.input.sessionId')=? AND status IN ('queued','running','awaiting_input','awaiting_acceptance','paused','interrupted','failed','limited')",
          )
          .get(id)
      )
        throw new AppError('PROJECT_BUSY', '请先停止此对话中的生成任务，再删除对话', 409);
      this.db.prepare('UPDATE sessions SET deleted_at=? WHERE id=?').run(now(), id);
      return this.sessionDetail(id, true);
    });
  }
  restoreSession(id: string) {
    return this.database.transaction(() => {
      this.sessionDetail(id, true);
      this.db.prepare('UPDATE sessions SET deleted_at=NULL WHERE id=?').run(id);
      return this.sessionDetail(id);
    });
  }
  sessions(projectId: string, limit = 50, cursor?: string, query = '', deleted = false) {
    this.novels.getProject(projectId);
    const boundary = cursor
      ? (this.db
          .prepare('SELECT * FROM sessions WHERE id=? AND project_id=?')
          .get(cursor, projectId) as Row | undefined)
      : undefined;
    if (cursor && (!boundary || Boolean(boundary.deleted_at) !== deleted))
      throw new AppError('NOT_FOUND', '会话分页游标不存在', 404);
    const boundaryTime = boundary
      ? String((deleted ? boundary.deleted_at : boundary.updated_at) ?? boundary.created_at)
      : '~';
    const rows = this.db
      .prepare(
        `SELECT s.id FROM sessions s WHERE project_id=? AND (deleted_at IS NOT NULL)=?
        AND (?='' OR instr(lower(title),lower(?))>0 OR EXISTS(SELECT 1 FROM messages WHERE session_id=s.id AND instr(lower(content),lower(?))>0)
          OR EXISTS(SELECT 1 FROM workflow_runs WHERE json_extract(state_json,'$.snapshot.input.sessionId')=s.id AND instr(lower(json_extract(state_json,'$.snapshot.input.input')),lower(?))>0))
        AND (COALESCE(deleted_at,updated_at,created_at)<? OR (COALESCE(deleted_at,updated_at,created_at)=? AND id<?))
        ORDER BY COALESCE(deleted_at,updated_at,created_at) DESC,id DESC LIMIT ?`,
      )
      .all(
        projectId,
        Number(deleted),
        query,
        query,
        query,
        query,
        boundaryTime,
        boundaryTime,
        cursor ?? '~',
        limit + 1,
      ) as Row[];
    return {
      data: rows.slice(0, limit).map((row) => this.sessionDetail(String(row.id), deleted)),
      nextCursor: rows.length > limit ? String(rows[limit - 1]?.id) : null,
    };
  }
  assertSession(input: WritingRunInput) {
    if (!input.sessionId) return;
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(input.sessionId) as
      | Row
      | undefined;
    if (
      !row ||
      row.deleted_at ||
      row.project_id !== input.projectId ||
      (row.chapter_id && row.chapter_id !== input.target?.documentId)
    )
      throw new AppError('FORBIDDEN', '会话不属于作品或目标章节', 403);
  }
  messages(id: string, limit = 50, cursor?: string) {
    this.sessionDetail(id);
    const boundary = cursor
      ? (this.db
          .prepare('SELECT rowid FROM messages WHERE id=? AND session_id=?')
          .get(cursor, id) as { rowid: number } | undefined)
      : undefined;
    if (cursor && !boundary) throw new AppError('NOT_FOUND', '消息分页游标不存在', 404);
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?')
      .all(id, boundary?.rowid ?? Number.MAX_SAFE_INTEGER, limit + 1) as Row[];
    return {
      data: rows
        .slice(0, limit)
        .reverse()
        .map((row) => ({
          id: row.id,
          runId: row.run_id,
          role: row.role,
          content: row.content,
          createdAt: row.created_at,
        })),
      nextCursor: rows.length > limit ? String(rows[limit - 1]?.id) : null,
    };
  }
  create(
    input: WritingRunInput,
    preview: ContextPreview,
    retryOf: string | null = null,
    workflowOwner?: string,
  ) {
    if (input.projectId) this.novels.getProject(input.projectId);
    this.assertSession(input);
    if (
      input.projectId &&
      (['write', 'rewrite'].includes(input.purpose) ||
        input.allowTargetProposal ||
        input.allowOutlineCreation ||
        input.allowChapterCreation) &&
      this.db
        .prepare(
          "SELECT id FROM element_generation_jobs WHERE project_id=? AND status IN ('queued','running')",
        )
        .get(input.projectId)
    )
      throw new AppError('PROJECT_BUSY', '作品正在生成基本信息，请先结束', 409);
    const owner = input.projectId
      ? (this.db
          .prepare(
            "SELECT id FROM workflow_runs WHERE project_id=? AND status IN ('queued','running','awaiting_input','awaiting_acceptance','paused','interrupted','failed','limited')",
          )
          .get(input.projectId) as { id: string } | undefined)
      : undefined;
    if (workflowOwner && owner?.id !== workflowOwner)
      throw new AppError('FORBIDDEN', '工作流未持有当前作品', 403);
    if (
      owner &&
      owner.id !== workflowOwner &&
      (['write', 'rewrite'].includes(input.purpose) ||
        input.allowTargetProposal ||
        input.allowOutlineCreation ||
        input.allowChapterCreation)
    )
      throw new AppError('PROJECT_BUSY', '作品有未结束的协作写作流程', 409);
    if (
      input.sessionId &&
      this.db
        .prepare(
          "SELECT id FROM runs WHERE session_id=? AND status IN ('queued','running','cancelling')",
        )
        .get(input.sessionId)
    )
      throw new AppError('PROJECT_BUSY', '会话已有运行，请等待或取消', 409);
    if (input.target && !retryOf)
      this.novels.assertVersion(input.target.documentId, input.target.baseVersionId);
    if (
      (['write', 'rewrite'].includes(input.purpose) || input.allowChapterCreation) &&
      this.db
        .prepare(
          "SELECT id FROM runs WHERE project_id=? AND (purpose IN ('write','rewrite') OR json_extract(input_json,'$.allowChapterCreation')=1) AND status IN ('queued','running','cancelling')",
        )
        .get(input.projectId)
    )
      throw new AppError('PROJECT_BUSY', '该作品已有写作任务，请等待或取消', 409);
    if (
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running','cancelling')",
          )
          .get() as { n: number }
      ).n >= 32
    )
      throw new AppError('PROJECT_BUSY', '运行队列已满', 409);
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO runs(id,project_id,session_id,purpose,status,retry_of_run_id,input_json,snapshot_json,context_hash,usage_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.projectId,
        input.sessionId,
        input.purpose,
        'queued',
        retryOf,
        JSON.stringify(input),
        JSON.stringify(preview),
        preview.hash,
        JSON.stringify(emptyUsage),
        now(),
      );
    for (const [ordinal, ref] of preview.allowed.entries()) {
      const doc = this.novels.getDocument(ref.documentId, Boolean(retryOf)).document;
      if (doc.projectId !== input.projectId)
        throw new AppError('FORBIDDEN', '冻结资料不属于作品', 403);
      this.db
        .prepare(
          'INSERT INTO run_documents(run_id,document_id,version_id,permission,selected,ordinal) VALUES(?,?,?,?,?,?)',
        )
        .run(
          id,
          ref.documentId,
          ref.versionId,
          canPropose(input) && input.target?.documentId === ref.documentId ? 'propose' : 'read',
          Number(ref.selected),
          ordinal,
        );
    }
    for (const ref of preview.entries) this.citation(id, -1, ref);
    if (input.sessionId)
      this.db
        .prepare(
          "INSERT INTO messages(id,session_id,run_id,role,content,created_at) VALUES(?,?,?,'user',?,?)",
        )
        .run(randomUUID(), input.sessionId, id, input.input, now());
    return this.summary(id);
  }
  citation(runId: string, turnIndex: number, ref: ContextEntry) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO run_context_entries(run_id,turn_index,citation_id,entry_json) VALUES(?,?,?,?)',
      )
      .run(runId, turnIndex, ref.citationId, JSON.stringify(ref));
  }
  append(event: RunEvent) {
    runEventSchema.parse(event);
    const current = this.row(event.runId);
    if (event.seq <= Number(current.last_event_seq)) throw new AgentError('STORAGE_ERROR');
    this.db
      .prepare('INSERT INTO run_events(run_id,seq,type,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(event.runId, event.seq, event.type, JSON.stringify(event), now());
    this.db.prepare('UPDATE runs SET last_event_seq=? WHERE id=?').run(event.seq, event.runId);
  }
  events(id: string, after: number, limit = 100) {
    const run = this.summary(id);
    if (after < run.eventFloor - 1)
      throw new AppError('EVENT_CURSOR_EXPIRED', '事件已过期，请重新读取运行快照', 410);
    if (after > run.lastEventSeq)
      throw new AppError('VALIDATION_ERROR', '事件游标超过当前序号', 400);
    return (
      this.db
        .prepare(
          'SELECT payload_json FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?',
        )
        .all(id, after, limit) as Row[]
    ).map((row) => runEventSchema.parse(decode(row.payload_json)));
  }
  expireEvents(id: string, through: number) {
    this.database.transaction((db) => {
      const run = this.summary(id);
      if (active(run.status) || through > run.lastEventSeq || through < run.eventFloor - 1)
        throw new AppError('VALIDATION_ERROR', '仅可清理已结束运行的有效事件范围', 400);
      db.prepare('DELETE FROM run_events WHERE run_id=? AND seq<=?').run(id, through);
      db.prepare('UPDATE runs SET event_floor=? WHERE id=?').run(through + 1, id);
    });
  }
  terminal(
    id: string,
    status: string,
    reason: string,
    usage: unknown,
    output: LoopResult['output'],
    supplied?: Extract<RunEvent, { type: 'run.finished' }>,
  ) {
    const row = this.row(id);
    if (!active(row.status)) return;
    if (row.status === 'cancelling' && status !== 'interrupted' && reason !== 'STORAGE_ERROR') {
      status = 'cancelled';
      reason = 'cancelled';
    }
    const event = runEventSchema.parse({
      ...supplied,
      schemaVersion: 1,
      runId: id,
      seq: supplied?.seq ?? Number(row.last_event_seq) + 1,
      type: 'run.finished',
      status,
      stopReason: reason,
      usage: {
        known: (usage as typeof emptyUsage).known,
        complete: (usage as typeof emptyUsage).complete,
      },
      outputMessageId: output?.messageId ?? null,
    });
    this.append(event);
    this.db
      .prepare(
        'UPDATE runs SET status=?,stop_reason=?,usage_json=?,output_json=?,finished_at=? WHERE id=?',
      )
      .run(
        status,
        reason,
        JSON.stringify(usage),
        output ? JSON.stringify(output) : null,
        now(),
        id,
      );
    this.db
      .prepare("UPDATE proposals SET status='abandoned' WHERE run_id=? AND status='staged'")
      .run(id);
    this.db
      .prepare(
        "UPDATE outline_creation_proposals SET status='abandoned' WHERE run_id=? AND status='staged'",
      )
      .run(id);
    this.db
      .prepare("UPDATE run_turns SET status=? WHERE run_id=? AND status<>'complete'")
      .run(status, id);
    if (row.session_id && output?.committed)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO messages(id,session_id,run_id,role,content,created_at) VALUES(?,?,?,'assistant',?,?)",
        )
        .run(output.messageId, row.session_id, id, output.text, now());
  }
  recover() {
    this.database.transaction(() => {
      for (const row of this.db
        .prepare(
          "SELECT id,usage_json,output_json FROM runs WHERE status IN ('queued','running','cancelling')",
        )
        .all() as Row[])
        this.terminal(
          String(row.id),
          'interrupted',
          'interrupted',
          decode(row.usage_json),
          row.output_json ? decode(row.output_json) : null,
        );
    });
  }
  proposal(id: string): Proposal {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new AppError('NOT_FOUND', '提议不存在', 404);
    return proposalSchema.parse({
      id: row.id,
      runId: row.run_id,
      turnIndex: row.turn_index,
      targetDocumentId: row.target_document_id,
      baseVersionId: row.base_version_id,
      scope: decode(row.scope_json),
      content: row.proposed_content,
      reason: row.reason,
      citations: decode(row.citations_json),
      status: row.status,
      acceptedVersionId: row.accepted_version_id,
      origin: row.origin,
      createdAt: row.created_at,
    });
  }
  proposals(runId: string) {
    return (
      this.db.prepare('SELECT id FROM proposals WHERE run_id=? ORDER BY rowid').all(runId) as {
        id: string;
      }[]
    ).map((row) => this.proposal(row.id));
  }
  insertProposal(
    input: Omit<Proposal, 'id' | 'status' | 'acceptedVersionId' | 'createdAt'>,
    executionId: string | null,
  ) {
    if (input.origin === 'candidate' && !isWorkflowProposal(this, input.runId))
      throw new AppError('FORBIDDEN', '聊天回复不能转换为文档提议，请通过文档工具提交正文。', 403);
    assertRunWriteMode(this, input.runId, 'modify');
    const id = randomUUID();
    const kind = this.novels.getDocument(input.targetDocumentId).document.kind;
    const content =
      kind === 'master_outline' || isStoryEventKind(kind)
        ? normalizeOutlineMarkdown(input.content)
        : input.content;
    this.db
      .prepare(
        'INSERT INTO proposals(id,run_id,turn_index,tool_execution_id,target_document_id,base_version_id,scope_json,proposed_content,reason,citations_json,status,origin,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.runId,
        input.turnIndex,
        executionId,
        input.targetDocumentId,
        input.baseVersionId,
        JSON.stringify(input.scope),
        content,
        input.reason,
        JSON.stringify(input.citations),
        input.origin === 'tool' ? 'staged' : 'pending',
        input.origin,
        now(),
      );
    return this.proposal(id);
  }
  candidate(_runId: string, _messageId: string, _key: string): Proposal {
    // Reject before consulting old idempotency responses, including requests from stale clients.
    throw new AppError(
      'FORBIDDEN',
      '聊天回复转正文的入口已停用，请让助手通过新建章节或文档修改工具提交候选。',
      403,
    );
  }
  accept(id: string, key: string) {
    try {
      return this.once(`accept:${id}`, key, {}, () => {
        const proposal = this.proposal(id);
        if (proposal.status === 'accepted' && proposal.acceptedVersionId)
          return { proposalId: id, acceptedVersionId: proposal.acceptedVersionId };
        if (proposal.status === 'stale')
          throw new AppError('VERSION_CONFLICT', '提议基准已过时，请比较后重新生成', 409);
        if (proposal.status !== 'pending')
          throw new AppError('FORBIDDEN', '只有待审阅提议可以接受', 403);
        if (proposal.origin === 'candidate' && !isWorkflowProposal(this, proposal.runId))
          throw new AppError(
            'FORBIDDEN',
            '此旧提议由聊天回复转换，不能写入文档。请拒绝它并通过文档工具重新生成。',
            403,
          );
        assertRunWriteMode(this, proposal.runId, 'modify');
        const parent = this.db
          .prepare(
            "SELECT state_json FROM workflow_runs WHERE status='awaiting_acceptance' AND json_extract(state_json,'$.proposalId')=?",
          )
          .get(id) as Row | undefined;
        if (parent) {
          const workflow = decode<WorkflowRun>(parent.state_json);
          const changed = Object.values(workflow.snapshot.contexts)
            .flatMap((p) => p.allowed)
            .some(
              (ref) =>
                ref.documentId !== proposal.targetDocumentId &&
                (() => {
                  const doc = this.novels.getDocument(ref.documentId, true).document;
                  return doc.currentVersionId !== ref.versionId || doc.deletedAt !== null;
                })(),
            );
          if (changed && !workflow.sourceSnapshotAccepted)
            throw new AppError(
              'VERSION_CONFLICT',
              '参考资料已更新，请明确沿用冻结资料或刷新资料后复审',
              409,
              { sourcesChanged: true },
            );
        }
        const current = this.novels.assertVersion(
          proposal.targetDocumentId,
          proposal.baseVersionId,
        );
        let content =
          current.document.kind === 'master_outline' || isStoryEventKind(current.document.kind)
            ? normalizeOutlineMarkdown(proposal.content)
            : proposal.content;
        if (proposal.scope.kind === 'selection') {
          const range = proposal.scope.selection;
          if (
            range.to > current.version.content.length ||
            digest(current.version.content.slice(range.from, range.to)) !== range.textHash
          )
            throw new AppError('VERSION_CONFLICT', '选区原文已变化', 409);
          content =
            current.version.content.slice(0, range.from) +
            content +
            current.version.content.slice(range.to);
        }
        if (content.length > 1_000_000)
          throw new AppError('VALIDATION_ERROR', '应用后文档超过长度限制', 400);
        const saved = this.novels.saveDocument(
          proposal.targetDocumentId,
          { baseVersionId: proposal.baseVersionId, content, metadata: current.version.metadata },
          'proposal',
        );
        // Accepting a planning draft is also the author's confirmation for later writing.
        if (isElementKind(saved.document.kind) && !readElementData(saved.version.metadata).archived)
          this.db
            .prepare(
              'INSERT INTO element_confirmations(document_id,confirmed_version_id) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET confirmed_version_id=excluded.confirmed_version_id',
            )
            .run(saved.document.id, saved.version.id);
        this.db
          .prepare("UPDATE proposals SET status='accepted',accepted_version_id=? WHERE id=?")
          .run(saved.version.id, id);
        this.finishWorkflowProposal(id, 'accepted');
        return { proposalId: id, acceptedVersionId: saved.version.id };
      });
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === 'VERSION_CONFLICT' &&
        !error.details?.sourcesChanged
      )
        this.database.transaction((db) =>
          db.prepare("UPDATE proposals SET status='stale' WHERE id=? AND status='pending'").run(id),
        );
      throw error;
    }
  }
  reject(id: string, finishWorkflow = true) {
    return this.database.transaction((db) => {
      const proposal = this.proposal(id);
      if (proposal.status === 'rejected') return proposal;
      if (!['pending', 'stale'].includes(proposal.status))
        throw new AppError('FORBIDDEN', '此提议不能拒绝', 403);
      db.prepare("UPDATE proposals SET status='rejected' WHERE id=?").run(id);
      if (finishWorkflow) this.finishWorkflowProposal(id, 'rejected');
      return this.proposal(id);
    });
  }
  private finishWorkflowProposal(proposalId: string, outcome: 'accepted' | 'rejected') {
    for (const row of this.db
      .prepare("SELECT id,state_json FROM workflow_runs WHERE status='awaiting_acceptance'")
      .all() as Row[]) {
      const state = decode<{
        proposalId: string;
        status: string;
        outcome: string;
        revision: number;
        updatedAt: string;
        reason: string | null;
      }>(row.state_json);
      if (state.proposalId !== proposalId) continue;
      state.status = 'completed';
      state.outcome = outcome;
      state.revision++;
      state.updatedAt = now();
      state.reason = null;
      this.db
        .prepare("UPDATE workflow_runs SET status='completed',state_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(state), state.updatedAt, row.id);
      const seq = (
        this.db
          .prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM workflow_events WHERE workflow_id=?')
          .get(row.id) as { seq: number }
      ).seq;
      this.db.prepare('INSERT INTO workflow_events VALUES(?,?,?)').run(
        row.id,
        seq,
        JSON.stringify({
          workflowId: row.id,
          seq,
          type: 'workflow.finished',
          status: 'completed',
          revision: state.revision,
          createdAt: state.updatedAt,
        }),
      );
    }
  }
}
