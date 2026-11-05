import {
  elementLabels,
  isElementKind,
  orderedChapters,
  type Structure,
  type WritingReference,
} from '@lingma/shared';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';

export const referenceToken = (reference: WritingReference) => `@【${reference.label}】`;

export function WritingMentions({
  value,
  onChange,
  references,
  onReferencesChange,
  onReference,
  structure,
  documentId,
  inputRef,
  disabled,
  placeholder,
  onSend,
}: {
  value: string;
  onChange(value: string): void;
  references: WritingReference[];
  onReferencesChange(references: WritingReference[]): void;
  onReference(reference: WritingReference): void;
  structure: Structure | null;
  documentId: string | undefined;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  placeholder: string;
  onSend(): void;
}) {
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [notice, setNotice] = useState('');
  const match = value.slice(0, caret).match(/@([^\n@【】]*)$/u);
  const query = match?.[1]?.trim().toLocaleLowerCase() ?? '';
  const open = Boolean(match && !dismissed && !disabled);
  const chapters = structure ? orderedChapters(structure) : [];
  const currentIndex = chapters.findIndex((chapter) => chapter.id === documentId);
  const candidates: WritingReference[] = [
    ...(structure?.volumes ?? []).map((volume) => ({
      type: 'volume' as const,
      id: volume.id,
      label: `卷：${volume.title}`,
    })),
    ...(structure?.documents ?? [])
      .filter(
        (document) =>
          !document.archived &&
          (document.kind !== 'chapter' ||
            currentIndex < 0 ||
            chapters.findIndex((chapter) => chapter.id === document.id) <= currentIndex),
      )
      .map((document) => ({
        type: 'document' as const,
        id: document.id,
        label: `${document.kind === 'chapter' ? '章节' : document.kind === 'chapter_outline' ? '故事事件' : isElementKind(document.kind) ? elementLabels[document.kind] : '资料'}：${document.title}`,
      })),
  ];
  const usedLabels = new Map(references.map((ref) => [ref.label, `${ref.type}:${ref.id}`]));
  const options = candidates
    .map((candidate) => {
      const identity = `${candidate.type}:${candidate.id}`;
      const previous = references.find(
        (ref) => ref.type === candidate.type && ref.id === candidate.id,
      );
      let label = previous?.label ?? candidate.label;
      let suffix = 2;
      while (usedLabels.has(label) && usedLabels.get(label) !== identity) {
        label = `${candidate.label}（${suffix++}）`;
      }
      usedLabels.set(label, identity);
      return { ...candidate, label };
    })
    .filter((candidate) => candidate.label.toLocaleLowerCase().includes(query))
    .slice(0, 50);
  const activeIndex = Math.min(index, Math.max(0, options.length - 1));
  const activeOption = options[activeIndex];
  const activeOptionId = activeOption
    ? `${listId}-${activeOption.type}-${activeOption.id}`
    : undefined;
  const selected = references.filter((reference) => value.includes(referenceToken(reference)));
  useEffect(() => {
    if (open && activeOptionId)
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, activeOptionId]);

  function select(reference: WritingReference) {
    if (!match) return;
    const start = caret - match[0].length;
    const token = `${referenceToken(reference)} `;
    const next = value.slice(0, start) + token + value.slice(caret);
    if (next.length > 32000) {
      setNotice('加入引用后超过 32000 字符，请精简提问。');
      return;
    }
    if (
      !selected.some((ref) => ref.type === reference.type && ref.id === reference.id) &&
      selected.length >= 200
    ) {
      setNotice('单次最多引用 200 项，请先移除部分引用。');
      return;
    }
    setNotice('');
    onChange(next);
    onReferencesChange([
      ...selected.filter((ref) => !(ref.type === reference.type && ref.id === reference.id)),
      reference,
    ]);
    onReference(reference);
    setDismissed(true);
    setCaret(start + token.length);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div
      className="writing-mentions"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDismissed(true);
      }}
    >
      <label className="chat-task">
        <span className="sr-only">写作任务</span>
        <textarea
          ref={inputRef}
          rows={2}
          value={value}
          maxLength={32000}
          disabled={disabled}
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? activeOptionId : undefined}
          onChange={(event) => {
            onChange(event.target.value);
            setCaret(event.target.selectionStart);
            setIndex(0);
            setDismissed(false);
            setNotice('');
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart);
          }}
          onClick={() => setDismissed(false)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              setIndex(
                (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
                  Math.max(1, options.length),
              );
            } else if (
              open &&
              (event.key === 'Tab' ||
                (event.key === 'Enter' && !event.ctrlKey && !event.metaKey)) &&
              activeOption
            ) {
              event.preventDefault();
              select(activeOption);
            } else if (open && event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(true);
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
        />
      </label>
      {open && (
        <div className="mention-picker" ref={list}>
          <p className="muted">引用卷或资料 · ↑↓ 选择，Enter 确认，Esc 关闭</p>
          <div role="listbox" id={listId} aria-label="引用卷或资料">
            {options.map((reference, optionIndex) => (
              <button
                type="button"
                role="option"
                key={`${reference.type}:${reference.id}`}
                id={`${listId}-${reference.type}-${reference.id}`}
                aria-selected={optionIndex === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(reference)}
              >
                {reference.label}
              </button>
            ))}
          </div>
          {!options.length && (
            <p className="muted" role="status">
              没有匹配的卷或资料。
            </p>
          )}
        </div>
      )}
      {selected.length > 0 && (
        <div className="mention-references" role="group" aria-label="本次引用">
          {selected.map((reference) => (
            <button
              type="button"
              key={`${reference.type}:${reference.id}`}
              disabled={disabled}
              title="移除此引用"
              aria-label={`移除引用：${reference.label}`}
              onClick={() => {
                onChange(value.replaceAll(referenceToken(reference), ''));
                onReferencesChange(
                  references.filter(
                    (ref) => !(ref.type === reference.type && ref.id === reference.id),
                  ),
                );
              }}
            >
              {reference.label} ×
            </button>
          ))}
        </div>
      )}
      <p className="mention-hint">输入 @ 引用卷、大纲、人物或其他资料。</p>
      {notice && (
        <p className="error" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
