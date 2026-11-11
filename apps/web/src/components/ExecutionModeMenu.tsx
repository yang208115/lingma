import { type WorkflowTemplate, workflowTaskLabels } from '@lingma/shared';
import { Check, ChevronDown, GitBranch, Sparkles } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export function ExecutionModeMenu({
  templates,
  value,
  onChange,
  allowDirect = true,
}: {
  templates: WorkflowTemplate[];
  value: string;
  onChange(value: string): void;
  allowDirect?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const published = templates.flatMap((template) => template.versions.slice(0, 1));
  const current = templates
    .flatMap((template) => template.versions)
    .find((version) => version.id === value);
  const choices =
    current && !published.some((version) => version.id === current.id)
      ? [...published, current]
      : published;
  const label = current?.config.name ?? (value ? '已选编排' : '直接生成');
  const Icon = value ? GitBranch : Sparkles;

  const position = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(320, window.innerWidth - 24);
    const above = rect.top - 20;
    const below = window.innerHeight - rect.bottom - 20;
    const upwards = above >= Math.min(360, below);
    setPlacement({
      position: 'fixed',
      width,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      ...(upwards ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
      maxHeight: Math.max(80, Math.min(420, upwards ? above : below)),
    });
  }, []);
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  function choose(next: string) {
    onChange(next);
    close(true);
  }
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !menu.current?.contains(event.target)
      )
        close();
    };
    const reposition = () => position();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, close, position]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const selected = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      (
        selected ?? menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
      )?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  return (
    <>
      <button
        ref={trigger}
        id={`${id}-trigger`}
        type="button"
        className="execution-mode-trigger"
        aria-label="执行方式"
        aria-describedby={`${id}-value`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={`执行方式：${label}${current ? ` · v${current.versionNo}` : ''}`}
        onClick={() => {
          if (open) close();
          else {
            position();
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            position();
            setOpen(true);
          }
        }}
      >
        <Icon size={14} aria-hidden="true" />
        <span id={`${id}-value`}>{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={`${id}-menu`}
            className="execution-mode-menu"
            style={placement}
            role="menu"
            aria-label="执行方式选项"
            onKeyDown={navigate}
          >
            <div className="execution-mode-menu-heading">执行方式</div>
            {allowDirect && (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!value}
                tabIndex={-1}
                className="execution-mode-option"
                onClick={() => choose('')}
              >
                <span className="execution-mode-icon">
                  <Sparkles size={16} aria-hidden="true" />
                </span>
                <span className="execution-mode-option-copy">
                  <strong>直接生成</strong>
                  <small>由当前模型直接完成任务</small>
                </span>
                {!value && <Check size={15} className="execution-mode-check" aria-hidden="true" />}
              </button>
            )}
            {Object.entries(workflowTaskLabels).map(([type, groupLabel]) => {
              const versions = choices.filter((version) => version.config.taskType === type);
              if (!versions.length) return null;
              return (
                <fieldset aria-label={groupLabel} className="execution-mode-group" key={type}>
                  <div className="execution-mode-group-label">{groupLabel}</div>
                  {versions.map((version) => (
                    <button
                      key={version.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={value === version.id}
                      tabIndex={-1}
                      className="execution-mode-option"
                      onClick={() => choose(version.id)}
                    >
                      <span className="execution-mode-icon">
                        <GitBranch size={16} aria-hidden="true" />
                      </span>
                      <span className="execution-mode-option-copy">
                        <strong>{version.config.name}</strong>
                      </span>
                      <span className="execution-mode-version">v{version.versionNo}</span>
                      {value === version.id && (
                        <Check size={15} className="execution-mode-check" aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </fieldset>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
