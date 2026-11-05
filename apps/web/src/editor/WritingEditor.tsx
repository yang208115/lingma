import {
  ClipboardPaste,
  Copy,
  MessageSquarePlus,
  Redo2,
  Scissors,
  TextSelect,
  Undo2,
} from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

type EditorMenu = {
  x: number;
  y: number;
  text: string;
  value: string;
  from: number;
  to: number;
  canUndo: boolean;
  canRedo: boolean;
  keyboard: boolean;
};

function commandAvailable(command: string) {
  try {
    return document.queryCommandEnabled(command);
  } catch {
    return false;
  }
}

export function WritingEditor({
  value,
  placeholder = '写下第一句话，让故事从这里开始……',
  onChange,
  onSelectionChange,
  onSendToAi,
}: {
  value: string;
  placeholder?: string | undefined;
  onChange(value: string): void;
  onSelectionChange(selection: { from: number; to: number }): void;
  onSendToAi(text: string): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<EditorMenu | null>(null);
  const [menuError, setMenuError] = useState('');
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const operation = useRef(0);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcut = mac ? '⌘' : 'Ctrl+';
  const closeMenu = useCallback(() => {
    operation.current += 1;
    setMenu(null);
    setMenuError('');
    setClipboardBusy(false);
  }, []);
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !menu) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
    if (menu.keyboard) {
      element
        .querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus({ preventScroll: true });
    } else if (ref.current?.value === menu.value) {
      // Mouse menus must not blur the textarea: inactive textarea selections lose their highlight.
      ref.current.focus({ preventScroll: true });
      ref.current.setSelectionRange(menu.from, menu.to);
    }
  }, [menu, menuError]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) closeMenu();
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) closeMenu();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', closeMenu);
      operation.current += 1;
    };
  }, [menu, closeMenu]);
  const resize = useCallback(() => {
    const editor = ref.current;
    if (!editor || editor.clientWidth === 0) return;
    const scroller = editor.closest('.writing-area');
    const scrollTop = scroller?.scrollTop ?? 0;
    editor.style.height = 'auto';
    editor.style.height = `${editor.scrollHeight}px`;
    if (scroller) scroller.scrollTop = scrollTop;
  }, []);

  useLayoutEffect(() => {
    // Remeasure after typing, restoring a version or applying an AI proposal.
    if (ref.current?.value === value) resize();
  }, [value, resize]);
  useLayoutEffect(() => {
    const editor = ref.current;
    if (!editor) return;
    let width = editor.clientWidth;
    const observer = new ResizeObserver(() => {
      if (editor.clientWidth === width) return;
      width = editor.clientWidth;
      resize();
    });
    observer.observe(editor);
    return () => observer.disconnect();
  }, [resize]);

  function restoreSelection() {
    const editor = ref.current;
    if (!editor || !menu || editor.value !== menu.value)
      throw new Error('正文已变化，请重新打开右键菜单。');
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(menu.from, menu.to);
    return editor;
  }

  function editCommand(command: string, text?: string) {
    const editor = restoreSelection();
    const previous = editor.value;
    // Native editing commands preserve the textarea's undo history, including cut and paste.
    const succeeded = document.execCommand(command, false, text);
    if (editor.value !== previous) onChange(editor.value);
    onSelectionChange({ from: editor.selectionStart, to: editor.selectionEnd });
    return succeeded || editor.value !== previous;
  }

  function historyCommand(command: 'undo' | 'redo') {
    if (!menu || clipboardBusy || !(command === 'undo' ? menu.canUndo : menu.canRedo)) return;
    try {
      if (!editCommand(command)) throw new Error('当前浏览器无法执行此操作，请使用键盘快捷键。');
      closeMenu();
    } catch (cause) {
      setMenuError(cause instanceof Error ? cause.message : '编辑操作失败，请重试。');
    }
  }

  async function clipboardCommand(command: 'copy' | 'cut' | 'paste') {
    if (!menu || clipboardBusy || (command !== 'paste' && !menu.text)) return;
    const ticket = ++operation.current;
    setClipboardBusy(true);
    setMenuError('');
    try {
      if (command === 'paste') {
        let text: string;
        try {
          if (!navigator.clipboard?.readText) throw new Error('Clipboard unavailable');
          text = await navigator.clipboard.readText();
        } catch {
          if (ticket !== operation.current || !ref.current) return;
          if (!editCommand('paste'))
            throw new Error(`无法读取剪贴板，请按 ${shortcut}V 粘贴，或允许浏览器访问剪贴板。`);
          closeMenu();
          return;
        }
        if (ticket !== operation.current || !ref.current) return;
        if (text && !editCommand('insertText', text))
          throw new Error(`当前浏览器无法插入文字，请按 ${shortcut}V 粘贴。`);
        if (!text) restoreSelection();
      } else {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(menu.text);
        } catch {
          if (ticket !== operation.current || !ref.current) return;
          restoreSelection();
          if (!document.execCommand('copy'))
            throw new Error(`复制失败，请按 ${shortcut}C 复制；原文已保留。`);
        }
        if (ticket !== operation.current || !ref.current) return;
        if (command === 'cut' && !editCommand('delete'))
          throw new Error('文字已复制，但无法剪切，请使用键盘快捷键；原文已保留。');
        if (command === 'copy') restoreSelection();
      }
      closeMenu();
    } catch (cause) {
      if (ticket === operation.current) {
        setClipboardBusy(false);
        setMenuError(cause instanceof Error ? cause.message : '剪贴板操作失败，原文已保留。');
      }
    }
  }

  function selectAll() {
    if (clipboardBusy) return;
    const editor = ref.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(0, editor.value.length);
    onSelectionChange({ from: 0, to: editor.value.length });
    closeMenu();
  }

  function openMenu(editor: HTMLTextAreaElement, x: number, y: number, keyboard: boolean) {
    closeMenu();
    const from = editor.selectionStart;
    const to = editor.selectionEnd;
    onSelectionChange({ from, to });
    const bounds = editor.getBoundingClientRect();
    setMenu({
      x: x || bounds.left + 24,
      y: y || Math.max(8, bounds.top) + 24,
      text: editor.value.slice(from, to),
      value: editor.value,
      from,
      to,
      canUndo: commandAvailable('undo'),
      canRedo: commandAvailable('redo'),
      keyboard,
    });
  }

  function menuKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      closeMenu();
      ref.current?.focus({ preventScroll: true });
    }
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
      );
      const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : currentIndex < 0
              ? event.key === 'ArrowUp'
                ? buttons.length - 1
                : 0
              : (currentIndex + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) %
                buttons.length;
      buttons[nextIndex]?.focus({ preventScroll: true });
    }
    if ((event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      const key = event.key.toLowerCase();
      if (['a', 'c', 'v', 'x', 'z', 'y'].includes(key)) event.preventDefault();
      if (key === 'a') selectAll();
      if (key === 'c') void clipboardCommand('copy');
      if (key === 'v') void clipboardCommand('paste');
      if (key === 'x') void clipboardCommand('cut');
      if (key === 'z') historyCommand(event.shiftKey ? 'redo' : 'undo');
      if (key === 'y') historyCommand('redo');
    }
  }

  return (
    <>
      <label className="sr-only" htmlFor="novel-content">
        文档正文
      </label>
      <textarea
        ref={ref}
        id="novel-content"
        className="novel-editor"
        value={value}
        rows={1}
        spellCheck={false}
        aria-haspopup="menu"
        aria-controls={menu ? 'writing-editor-menu' : undefined}
        onContextMenu={(event) => {
          if (event.shiftKey) {
            closeMenu();
            return;
          }
          event.preventDefault();
          openMenu(event.currentTarget, event.clientX, event.clientY, false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            openMenu(event.currentTarget, 0, 0, true);
          } else if (menu) {
            if (['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
              menuKeyDown(event);
            else closeMenu();
          }
        }}
        onChange={(event) => onChange(event.target.value)}
        onSelect={(event) =>
          onSelectionChange({
            from: event.currentTarget.selectionStart,
            to: event.currentTarget.selectionEnd,
          })
        }
        placeholder={placeholder}
      />
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            id="writing-editor-menu"
            className="writing-context-menu"
            role="menu"
            aria-label="正文编辑菜单"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(event) => event.preventDefault()}
            onKeyDown={menuKeyDown}
          >
            <div className="writing-context-caption" role="presentation">
              {menu.text
                ? `已选中 ${Array.from(menu.text).length.toLocaleString()} 字符`
                : '正文编辑'}
            </div>
            <button
              type="button"
              role="menuitem"
              disabled={clipboardBusy || !menu.canUndo}
              onClick={() => historyCommand('undo')}
            >
              <Undo2 size={15} aria-hidden="true" />
              <span>撤销</span>
              <kbd>{shortcut}Z</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={clipboardBusy || !menu.canRedo}
              onClick={() => historyCommand('redo')}
            >
              <Redo2 size={15} aria-hidden="true" />
              <span>重做</span>
              <kbd>{mac ? '⌘⇧Z' : 'Ctrl+Y'}</kbd>
            </button>
            <div className="writing-context-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              disabled={clipboardBusy || !menu.text}
              onClick={() => void clipboardCommand('cut')}
            >
              <Scissors size={15} aria-hidden="true" />
              <span>剪切</span>
              <kbd>{shortcut}X</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={clipboardBusy || !menu.text}
              onClick={() => void clipboardCommand('copy')}
            >
              <Copy size={15} aria-hidden="true" />
              <span>复制</span>
              <kbd>{shortcut}C</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={clipboardBusy}
              onClick={() => void clipboardCommand('paste')}
            >
              <ClipboardPaste size={15} aria-hidden="true" />
              <span>粘贴</span>
              <kbd>{shortcut}V</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={clipboardBusy || !menu.value}
              onClick={selectAll}
            >
              <TextSelect size={15} aria-hidden="true" />
              <span>全选</span>
              <kbd>{shortcut}A</kbd>
            </button>
            <div className="writing-context-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              disabled={clipboardBusy || !menu.text.trim()}
              onClick={() => {
                onSendToAi(menu.text);
                closeMenu();
              }}
            >
              <MessageSquarePlus size={16} aria-hidden="true" />
              发送到 AI 对话框
            </button>
            {menuError && (
              <p className="writing-context-error" role="alert">
                {menuError}
              </p>
            )}
            <div className="writing-context-hint" role="presentation">
              Shift + 右键打开默认菜单
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
