import { useEffect, useRef, useState } from 'react';

const minimumWidth = 180;
function dimensions(handle: HTMLDivElement) {
  const workbench = handle.parentElement;
  const sidebar = workbench?.querySelector(':scope > .outline-sidebar');
  const editorMinimum = workbench
    ? Number.parseFloat(
        getComputedStyle(workbench).getPropertyValue('--outline-editor-min-width'),
      ) || 260
    : 260;
  return {
    current: sidebar?.getBoundingClientRect().width ?? 260,
    max: Math.max(minimumWidth, (workbench?.clientWidth ?? 1000) - editorMinimum - 300),
  };
}

export function OutlineResizeHandle({ onResize }: { onResize(width: number | null): void }) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState({ current: 260, max: 1000 });
  useEffect(() => {
    const element = handle.current;
    const workbench = element?.parentElement;
    const sidebar = workbench?.querySelector(':scope > .outline-sidebar');
    if (!element || !workbench || !sidebar) return;
    const observer = new ResizeObserver(() => setSize(dimensions(element)));
    observer.observe(workbench);
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, []);
  const resize = (element: HTMLDivElement, width: number) =>
    onResize(Math.round(Math.min(dimensions(element).max, Math.max(minimumWidth, width))));
  return (
    // biome-ignore lint/a11y/useSemanticElements: An interactive splitter exposes its adjustable value and keyboard controls.
    <div
      ref={handle}
      role="separator"
      tabIndex={0}
      aria-label="调整故事大纲侧栏宽度"
      aria-orientation="vertical"
      aria-controls="workspace-outline-sidebar"
      aria-valuemin={minimumWidth}
      aria-valuemax={Math.round(size.max)}
      aria-valuenow={Math.round(size.current)}
      className={`outline-resize-handle${dragging ? ' is-dragging' : ''}`}
      title="拖动调整大纲宽度；方向键微调，双击恢复默认"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          width: dimensions(event.currentTarget).current,
        };
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.pointerId === event.pointerId)
          resize(event.currentTarget, start.width + event.clientX - start.x);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => onResize(null)}
      onKeyDown={(event) => {
        const measured = dimensions(event.currentTarget);
        const step = event.shiftKey ? 48 : 16;
        if (event.key === 'Enter') {
          event.preventDefault();
          onResize(null);
          return;
        }
        const next =
          event.key === 'ArrowLeft'
            ? measured.current - step
            : event.key === 'ArrowRight'
              ? measured.current + step
              : event.key === 'Home'
                ? minimumWidth
                : event.key === 'End'
                  ? measured.max
                  : null;
        if (next === null) return;
        event.preventDefault();
        resize(event.currentTarget, next);
      }}
    >
      <span />
    </div>
  );
}
