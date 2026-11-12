import type { Project } from '@lingma/shared';
import { BookOpen, Check, ChevronDown, Search } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useId, useRef, useState } from 'react';
import { projectOptionLabel } from '../document-label.js';

export function ProjectNavigationPicker({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(value);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const current = projects.find((project) => project.id === value);
  const filtered = projects.filter((project) =>
    projectOptionLabel(project, projects)
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const active = filtered.find((project) => project.id === activeId) ?? filtered[0];

  const position = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(340, window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 20;
    const above = rect.top - 20;
    const upwards = below < 260 && above > below;
    setPlacement({
      width,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      ...(upwards
        ? { top: 'auto', bottom: window.innerHeight - rect.top + 8 }
        : { top: rect.bottom + 8, bottom: 'auto' }),
      maxHeight: Math.max(120, Math.min(420, upwards ? above : below)),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => search.current?.focus());
    window.addEventListener('resize', position);
    // Popovers escape the scrolling sidebar, so keep the panel next to its trigger.
    const scroll = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      position();
    };
    window.addEventListener('scroll', scroll, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open, position]);

  useEffect(() => {
    if (open && active?.id) {
      document.getElementById(`${id}-${active.id}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, active?.id, id]);

  function close() {
    panel.current?.hidePopover();
    trigger.current?.focus();
  }
  function show() {
    setQuery('');
    setActiveId(value);
    position();
    panel.current?.showPopover();
  }
  function choose(next: string) {
    close();
    onChange(next);
  }

  return (
    <div className="project-navigation-picker">
      <button
        ref={trigger}
        type="button"
        className="project-navigation-trigger"
        aria-label="当前作品"
        aria-describedby={`${id}-current`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        title={current ? projectOptionLabel(current, projects) : '选择作品'}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            show();
          }
        }}
      >
        <BookOpen size={16} aria-hidden="true" />
        <span id={`${id}-current`} className="project-navigation-current">
          <strong>{current?.title ?? '选择作品'}</strong>
          <small>
            {current ? (current.format === 'short' ? '短篇作品' : '长篇作品') : '开启一段新故事'}
          </small>
        </span>
        <ChevronDown size={14} className="project-navigation-chevron" aria-hidden="true" />
      </button>
      <div
        ref={panel}
        id={`${id}-panel`}
        role="dialog"
        aria-label="切换作品"
        popover="auto"
        className="project-navigation-panel"
        style={placement}
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === 'Tab') {
            close();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const index = filtered.findIndex((project) => project.id === active?.id);
            const next =
              (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length;
            setActiveId(filtered[next]?.id ?? '');
          } else if (event.key === 'Enter' && active) {
            event.preventDefault();
            choose(active.id);
          }
        }}
      >
        <div className="project-navigation-heading">
          <span>切换作品</span>
          <small>{projects.length} 部作品</small>
        </div>
        <div className="project-navigation-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={search}
            role="combobox"
            aria-label="搜索作品"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={active ? `${id}-${active.id}` : undefined}
            placeholder="搜索作品名称…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveId('');
            }}
          />
        </div>
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label="作品列表"
          className="project-navigation-list"
        >
          {filtered.map((project) => (
            <button
              id={`${id}-${project.id}`}
              key={project.id}
              type="button"
              role="option"
              aria-selected={project.id === value}
              aria-label={projectOptionLabel(project, projects)}
              tabIndex={-1}
              className={`project-navigation-option${project.id === active?.id ? ' is-active' : ''}`}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(project.id)}
            >
              <BookOpen size={16} aria-hidden="true" />
              <span className="project-navigation-option-copy">
                <strong>{project.title}</strong>
                <small>
                  {project.format === 'short' ? '短篇' : '长篇'}
                  {projects.some(
                    (other) => other.id !== project.id && other.title === project.title,
                  )
                    ? ` · ${project.id.slice(0, 8)}`
                    : ''}
                </small>
              </span>
              {project.id === value && (
                <Check size={16} className="project-navigation-check" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
        {!filtered.length && (
          <p className="project-navigation-empty" role="status">
            {projects.length ? '没有找到匹配的作品' : '还没有作品，先去创建一本吧'}
          </p>
        )}
        <button type="button" className="project-navigation-manage" onClick={() => choose('')}>
          查看全部作品 <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}
