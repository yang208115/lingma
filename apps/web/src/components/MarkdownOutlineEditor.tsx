import { Eye, Pencil } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { WritingEditor } from '../editor/WritingEditor.js';
import { MarkdownContent } from './MarkdownContent.js';

export function MarkdownOutlineEditor(props: ComponentProps<typeof WritingEditor>) {
  const [mode, setMode] = useState<'preview' | 'edit'>('edit');

  function changeMode(next: typeof mode) {
    if (next === mode) return;
    props.onSelectionChange({ from: 0, to: 0 });
    setMode(next);
  }

  return (
    <div className="outline-content-editor">
      <div className="outline-content-toolbar">
        <span>大纲内容</span>
        <div className="outline-content-switch">
          <button
            type="button"
            aria-pressed={mode === 'preview'}
            onClick={() => changeMode('preview')}
          >
            <Eye size={14} aria-hidden="true" />
            预览
          </button>
          <button type="button" aria-pressed={mode === 'edit'} onClick={() => changeMode('edit')}>
            <Pencil size={14} aria-hidden="true" />
            编辑原文
          </button>
        </div>
      </div>
      {mode === 'preview' ? (
        <div className="outline-markdown-preview">
          {props.value.trim() ? (
            <MarkdownContent text={props.value} outline />
          ) : (
            <p className="muted">还没有大纲内容，点击“编辑原文”开始撰写。</p>
          )}
        </div>
      ) : (
        <WritingEditor {...props} />
      )}
    </div>
  );
}
