import { useEffect, useRef, useState } from 'react';

const minimumWidth = 300;

function dimensions(handle: HTMLDivElement) {
  const aside = handle.parentElement;
  const workbench = aside?.parentElement;
  const sidebar = workbench?.querySelector(':scope > .sidebar');
  const outlineMinimum = workbench
    ? Number.parseFloat(getComputedStyle(workbench).getPropertyValue('--outline-editor-min-width'))
    : 0;
  const editorWidth =
    outlineMinimum || (workbench?.classList.contains('writing-workbench') ? 260 : 320);
  return {
    current: aside?.getBoundingClientRect().width ?? 400,
    max: Math.max(
      minimumWidth,
      (workbench?.clientWidth ?? 1020) -
        (sidebar?.getBoundingClientRect().width ?? 0) -
        editorWidth,
    ),
  };
}

export function AssistantResizeHandle({ onResize }: { onResize(width: number | null): void }) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number; max: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState({ current: 400, max: 1000 });

  useEffect(() => {
    const element = handle.current;
    const aside = element?.parentElement;
    const workbench = aside?.parentElement;
    if (!element || !aside || !workbench) return;
    const observer = new ResizeObserver(() => setSize(dimensions(element)));
    observer.observe(aside);
    observer.observe(workbench);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={handle}
      role="separator"
      aria-label="调整 AI 助手宽度"
      aria-orientation="vertical"
      aria-valuemin={minimumWidth}
      aria-valuemax={Math.round(size.max)}
      aria-valuenow={Math.round(size.current)}
      aria-controls="workspace-ai-assistant"
      tabIndex={0}
      className={`assistant-resize-handle${dragging ? ' is-dragging' : ''}`}
      title="拖动调整助手宽度；方向键微调，双击恢复默认"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        const measured = dimensions(event.currentTarget);
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          width: measured.current,
          max: measured.max,
        };
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        onResize(
          Math.round(
            Math.min(start.max, Math.max(minimumWidth, start.width + start.x - event.clientX)),
          ),
        );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => onResize(null)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        const measured = dimensions(event.currentTarget);
        let next: number | null;
        switch (event.key) {
          case 'ArrowLeft':
            next = measured.current + step;
            break;
          case 'ArrowRight':
            next = measured.current - step;
            break;
          case 'Home':
            next = minimumWidth;
            break;
          case 'End':
            next = measured.max;
            break;
          case 'Enter':
            next = null;
            break;
          default:
            return;
        }
        event.preventDefault();
        onResize(
          next === null ? null : Math.round(Math.min(measured.max, Math.max(minimumWidth, next))),
        );
      }}
    >
      <span />
    </div>
  );
}
