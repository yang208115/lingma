import { elementFields, metadataSchema, readElementData, type Structure } from '@lingma/shared';

export function PlanningFields({
  kind,
  versionId,
  confirmedVersionId,
  dirty,
  metadataText,
  onChange,
  structure,
  onOpenDocument,
  onArchiveChange,
  onConfirm,
  busy,
}: {
  kind: 'master_outline' | 'timeline_event';
  versionId: string;
  confirmedVersionId: string | null | undefined;
  dirty: boolean;
  metadataText: string;
  onChange(text: string): void;
  structure: Structure;
  onOpenDocument(id: string): void;
  onArchiveChange(archived: boolean): void;
  onConfirm(): void;
  busy: boolean;
}) {
  let metadata: ReturnType<typeof metadataSchema.parse>;
  let data: ReturnType<typeof readElementData>;
  try {
    metadata = metadataSchema.parse(JSON.parse(metadataText));
    data = readElementData(metadata);
  } catch {
    return (
      <p className="warning" role="alert">
        文档信息格式有误，请在下方文档信息中修复后编辑结构字段。
      </p>
    );
  }
  const fields = Object.entries(elementFields[kind]).filter(([key]) => key !== 'time');
  const confirmed = confirmedVersionId === versionId && !dirty;
  return (
    <section
      className="planning-fields"
      aria-label={kind === 'master_outline' ? '故事结构' : '事件脉络'}
    >
      <div className="planning-adoption" role="status">
        <span>
          {data.archived
            ? '此资料已归档，不参与写作参考'
            : confirmed
              ? '当前版本已确认用于写作'
              : confirmedVersionId === undefined
                ? '正在读取写作采用状态…'
                : confirmedVersionId
                  ? '当前修改尚未确认，写作仍沿用已确认版本'
                  : '当前版本尚未确认用于写作'}
        </span>
        {!data.archived && (
          <button
            type="button"
            disabled={busy || confirmed || confirmedVersionId === undefined}
            onClick={onConfirm}
          >
            {confirmed ? '已确认用于写作' : '确认用于写作'}
          </button>
        )}
      </div>
      <details open={fields.some(([key]) => Boolean(data.fields[key]?.trim()))}>
        <summary>
          {kind === 'master_outline'
            ? '故事结构：起点、转折与结局'
            : '事件脉络：前因、后果与参与者'}
        </summary>
        {fields.map(([key, label]) => (
          <label key={key}>
            {label}
            <textarea
              rows={3}
              maxLength={16000}
              value={data.fields[key] ?? ''}
              onChange={(change) => {
                onChange(
                  JSON.stringify(
                    {
                      ...metadata,
                      element: { ...data, fields: { ...data.fields, [key]: change.target.value } },
                    },
                    null,
                    2,
                  ),
                );
              }}
            />
          </label>
        ))}
      </details>
      <details>
        <summary>资料属性与写作采用</summary>
        {kind === 'master_outline' && (
          <label>
            总纲简述
            <textarea
              rows={3}
              maxLength={4000}
              value={data.summary}
              onChange={(change) =>
                onChange(
                  JSON.stringify(
                    { ...metadata, element: { ...data, summary: change.target.value } },
                    null,
                    2,
                  ),
                )
              }
            />
          </label>
        )}
        <label>
          内容性质
          <select
            value={data.nature}
            onChange={(change) =>
              onChange(
                JSON.stringify(
                  { ...metadata, element: { ...data, nature: change.target.value } },
                  null,
                  2,
                ),
              )
            }
          >
            <option value="planned">未来规划</option>
            <option value="established">已发生事实</option>
            <option value="rule">固定设定</option>
          </select>
        </label>
        <div className="row">
          <button type="button" disabled={busy} onClick={() => onArchiveChange(!data.archived)}>
            {data.archived ? '恢复归档' : '归档此资料'}
          </button>
        </div>
      </details>
      {(data.links.length > 0 || data.sources.length > 0) && (
        <details>
          <summary>关联与引用</summary>
          {data.links.map((link) => (
            <p key={`${link.targetId}:${link.label}:${link.nature}`}>
              <button type="button" onClick={() => onOpenDocument(link.targetId)}>
                {structure.documents.find((document) => document.id === link.targetId)?.title ??
                  link.targetId}
              </button>{' '}
              · {link.label}
            </p>
          ))}
          {data.sources.map((source) => (
            <p key={`${source.documentId}:${source.versionId}:${source.from}:${source.to}`}>
              <button type="button" onClick={() => onOpenDocument(source.documentId)}>
                {structure.documents.find((document) => document.id === source.documentId)?.title ??
                  source.documentId}
              </button>{' '}
              · 历史版本引用
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
