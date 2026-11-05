import type { DocumentVersion } from '@lingma/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { DiffView } from './DiffView.js';
import { Modal } from './Modal.js';

type Summary = Omit<DocumentVersion, 'content' | 'metadata'>;
export function History({
  documentId,
  canRestore,
  onRestore,
  onClose,
}: {
  documentId: string;
  canRestore: boolean;
  onRestore(id: string): Promise<void>;
  onClose(): void;
}) {
  const [versions, setVersions] = useState<Summary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [pair, setPair] = useState<[DocumentVersion, DocumentVersion] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .versions(documentId)
      .then((page) => {
        if (active) {
          setVersions(page.data);
          setCursor(page.nextCursor);
          setLeft(page.data[1]?.id ?? page.data[0]?.id ?? '');
          setRight(page.data[0]?.id ?? '');
        }
      })
      .catch((error: Error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [documentId]);
  useEffect(() => {
    let active = true;
    setPair(null);
    if (left && right)
      void Promise.all([api.version(documentId, left), api.version(documentId, right)])
        .then((value) => {
          if (active) setPair(value);
        })
        .catch((error: Error) => {
          if (active) setError(error.message);
        });
    return () => {
      active = false;
    };
  }, [documentId, left, right]);
  async function restore() {
    setBusy(true);
    setError('');
    try {
      await onRestore(left);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : '恢复失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal labelledBy="history-title" onClose={onClose}>
      <div className="dialog wide">
        <div className="section-heading">
          <h2 id="history-title">版本历史与差异</h2>
          <button type="button" onClick={onClose}>
            关闭历史
          </button>
        </div>
        <p className="muted">
          恢复会新建版本，恢复前的内容仍可在历史中找回。名称与目录排序独立维护。
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="row">
          <label>
            比较起点
            <select value={left} onChange={(event) => setLeft(event.target.value)}>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  版本 {version.versionNo} · {version.source} ·{' '}
                  {new Date(version.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <label>
            比较终点
            <select value={right} onChange={(event) => setRight(event.target.value)}>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  版本 {version.versionNo} · {version.source}
                </option>
              ))}
            </select>
          </label>
        </div>
        {cursor && (
          <button
            type="button"
            onClick={() => {
              void api
                .versions(documentId, cursor)
                .then((page) => {
                  setVersions((old) => [...old, ...page.data]);
                  setCursor(page.nextCursor);
                })
                .catch((error: Error) => setError(error.message));
            }}
          >
            加载更早版本
          </button>
        )}
        {pair && (
          <>
            <DiffView before={pair[0].content} after={pair[1].content} />
            <h3>元数据变化</h3>
            <DiffView
              before={JSON.stringify(pair[0].metadata, null, 2)}
              after={JSON.stringify(pair[1].metadata, null, 2)}
            />
          </>
        )}
        {!canRestore && <p className="error">请先保存或处理当前草稿，再恢复历史。</p>}
        <button
          type="button"
          className="primary"
          disabled={!canRestore || !left || busy}
          onClick={() => {
            void restore();
          }}
        >
          将起点版本恢复为新版本
        </button>
      </div>
    </Modal>
  );
}
