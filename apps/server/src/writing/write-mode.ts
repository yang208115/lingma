import { AppError } from '../errors.js';
import type { WritingStore } from './store.js';

const lineage = `WITH RECURSIVE lineage(id,retry_of_run_id) AS (
  SELECT id,retry_of_run_id FROM runs WHERE id=?
  UNION
  SELECT r.id,r.retry_of_run_id FROM runs r JOIN lineage l ON r.id=l.retry_of_run_id
)`;

export function assertRunWriteMode(store: WritingStore, runId: string, mode: 'create' | 'modify') {
  // Completed writes retain their mode across retries; abandoned partial turns do not.
  const conflict =
    mode === 'create'
      ? store.db
          .prepare(`${lineage}
        SELECT p.id FROM proposals p JOIN lineage l ON l.id=p.run_id
        WHERE p.origin='tool' AND p.status<>'abandoned' LIMIT 1`)
          .get(runId)
      : store.db
          .prepare(`${lineage}
        SELECT p.id FROM outline_creation_proposals p JOIN lineage l ON l.id=p.run_id
        WHERE json_extract(p.payload_json,'$.kind')='chapter' AND p.status<>'abandoned' LIMIT 1`)
          .get(runId);
  if (conflict)
    throw new AppError(
      'FORBIDDEN',
      mode === 'create'
        ? '本次运行已提交修改已有文档的提议，不能再新建章节。请另发一条新建章节任务。'
        : '本次运行已提交新建章节候选，不能再修改已有文档。请另发一条修改任务。',
      403,
    );
}

export function isWorkflowProposal(store: WritingStore, runId: string): boolean {
  return Boolean(
    store.db
      .prepare(
        'SELECT run_id FROM workflow_node_attempts WHERE run_id=? AND workflow_id IS NOT NULL',
      )
      .get(runId),
  );
}
