import {
  AgentError,
  type CompletedTurn,
  type LoopRecord,
  type LoopRecorder,
  type LoopResult,
  LoopStop,
  UsageAccumulator,
} from '@lingma/agent';
import { actionSchemas, type RunEvent } from '@lingma/shared';
import { entry } from './context.js';
import type { WritingStore } from './store.js';

export class SqlLoopRecorder implements LoopRecorder {
  private pending: RunEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure = false;
  private readonly usage = new UsageAccumulator();
  private callIndex = -1;
  constructor(
    private readonly store: WritingStore,
    private readonly id: string,
    private readonly onFailure: () => void,
  ) {}
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.failure) throw new AgentError('STORAGE_ERROR');
    if (!this.pending.length) return;
    const events = this.pending;
    try {
      this.store.database.transaction((db) => {
        for (const event of events) {
          this.store.append(event);
          if (event.type === 'text.delta')
            db.prepare(
              'UPDATE run_turns SET partial_text=partial_text||? WHERE run_id=? AND turn_index=?',
            ).run(event.text, this.id, event.turnIndex);
          if (event.type === 'thinking.delta')
            db.prepare(
              'UPDATE run_turns SET thinking=thinking||? WHERE run_id=? AND turn_index=?',
            ).run(event.text, this.id, event.turnIndex);
        }
      });
      this.pending = [];
    } catch {
      this.failure = true;
      throw new AgentError('STORAGE_ERROR');
    }
  }
  dispose() {
    clearTimeout(this.timer);
  }
  record(record: LoopRecord) {
    if (this.failure) throw new AgentError('STORAGE_ERROR');
    if (record.kind === 'model_event') return;
    if (
      record.kind === 'event' &&
      ['text.delta', 'thinking.delta', 'tool.arguments.delta'].includes(record.event.type)
    ) {
      const event = structuredClone(record.event),
        last = this.pending.at(-1);
      if (
        (event.type === 'text.delta' || event.type === 'thinking.delta') &&
        last?.type === event.type &&
        last.messageId === event.messageId
      ) {
        last.text += event.text;
        last.seq = event.seq;
      } else if (
        event.type === 'tool.arguments.delta' &&
        last?.type === 'tool.arguments.delta' &&
        last.turnIndex === event.turnIndex &&
        last.callIndex === event.callIndex
      ) {
        last.delta += event.delta;
        last.seq = event.seq;
      } else this.pending.push(event);
      if (JSON.stringify(this.pending).length >= 4096) this.flush();
      else
        this.timer ??= setTimeout(() => {
          try {
            this.flush();
          } catch {
            this.onFailure();
          }
        }, 50);
      return;
    }
    this.flush();
    this.store.database.transaction((db) => {
      if (record.kind === 'event') {
        if (record.event.type === 'model.retry')
          db.prepare(
            "UPDATE run_turns SET status='retrying' WHERE run_id=? AND turn_index=? AND status='running'",
          ).run(this.id, record.event.turnIndex);
        if (record.event.type === 'tool.started')
          db.prepare(
            'INSERT INTO tool_executions(id,run_id,turn_index,call_id,name) VALUES(?,?,?,?,?)',
          ).run(
            record.event.executionId,
            this.id,
            record.event.turnIndex,
            record.event.callId,
            record.event.name,
          );
        this.store.append(record.event);
      } else if (record.kind === 'request') {
        const inserted = db
          .prepare(
            "INSERT INTO run_turns(run_id,turn_index,status,request_json) VALUES(?,?,'running',?) ON CONFLICT(run_id,turn_index) DO UPDATE SET status='running',request_json=excluded.request_json,partial_text='',thinking='',response_json=NULL WHERE run_turns.status='retrying'",
          )
          .run(this.id, record.turnIndex, JSON.stringify(record.request));
        if (inserted.changes !== 1) throw new AgentError('STORAGE_ERROR');
        this.callIndex = this.usage.begin();
        db.prepare('UPDATE runs SET usage_json=? WHERE id=?').run(
          JSON.stringify(this.usage.summary()),
          this.id,
        );
      } else if (record.kind === 'response') {
        db.prepare(
          'UPDATE run_turns SET response_json=?,partial_text=?,thinking=COALESCE(?,thinking) WHERE run_id=? AND turn_index=?',
        ).run(
          JSON.stringify(record.response),
          record.response.text,
          record.response.thinking ?? null,
          this.id,
          record.turnIndex,
        );
        this.usage.set(this.callIndex, record.response.usage);
        db.prepare('UPDATE runs SET usage_json=? WHERE id=?').run(
          JSON.stringify(this.usage.summary()),
          this.id,
        );
      } else if (record.kind === 'action') {
        if (record.result.ok && ['read_document', 'search_documents'].includes(record.call.name)) {
          const citations =
            record.call.name === 'read_document'
              ? [actionSchemas.read_document.result.parse(record.result.value)]
              : actionSchemas.search_documents.result.parse(record.result.value).matches;
          for (const citation of citations) {
            const range = /#(\d+)-(\d+)$/.exec(citation.citationId);
            if (!range) throw new AgentError('STORAGE_ERROR');
            const doc = this.store.novels.getDocument(citation.documentId, true).document;
            const version = this.store.novels.getVersion(citation.documentId, citation.versionId);
            this.store.citation(
              this.id,
              record.turnIndex,
              entry(doc, version, Number(range[1]), Number(range[2]), false, '动作实际返回'),
            );
          }
        }
        db.prepare(
          'UPDATE tool_executions SET args_json=?,result_json=? WHERE id=? AND run_id=?',
        ).run(
          JSON.stringify(record.call.arguments),
          JSON.stringify(record.result),
          record.executionId,
          this.id,
        );
      }
    });
  }
  commitTurn(turn: CompletedTurn, signal: AbortSignal) {
    this.flush();
    this.store.database.transaction((db) => {
      if (signal.aborted || this.store.row(this.id).status === 'cancelling')
        throw new LoopStop('cancelled');
      if (this.store.row(this.id).status !== 'running') throw new AgentError('STORAGE_ERROR');
      db.prepare(
        "UPDATE run_turns SET status='complete',checkpoint_json=? WHERE run_id=? AND turn_index=?",
      ).run(JSON.stringify(turn.checkpoint), this.id, turn.turnIndex);
      db.prepare('UPDATE runs SET checkpoint_json=?,output_json=? WHERE id=?').run(
        JSON.stringify(turn.checkpoint),
        JSON.stringify({ messageId: turn.messageId, text: turn.response.text, committed: true }),
        this.id,
      );
      db.prepare(
        "UPDATE proposals SET status='pending' WHERE run_id=? AND turn_index=? AND status='staged'",
      ).run(this.id, turn.turnIndex);
      db.prepare(
        "UPDATE outline_creation_proposals SET status='pending' WHERE run_id=? AND turn_index=? AND status='staged'",
      ).run(this.id, turn.turnIndex);
      for (const event of turn.events) this.store.append(event);
    });
  }
  finish(result: LoopResult, event: Extract<RunEvent, { type: 'run.finished' }>) {
    this.flush();
    this.store.database.transaction(() =>
      this.store.terminal(
        this.id,
        result.status,
        result.stopReason,
        result.usage,
        result.output,
        event,
      ),
    );
  }
}
