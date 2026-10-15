import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export function Modal({ open, title, close, children }: { open: boolean; title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    if (!open) return;
    const initiator = document.activeElement as HTMLElement | null;
    element.showModal();
    (element.querySelector<HTMLElement>('[data-initial-focus]') ?? element.querySelector<HTMLElement>('button'))?.focus();
    return () => {
      element.close();
      const target = initiator?.isConnected && initiator.getClientRects().length && !initiator.matches(':disabled') ? initiator : document.getElementById('create-task-action');
      target?.focus({ preventScroll: true });
    };
  }, [open]);
  return <dialog ref={dialog} className="workspace-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex="0"]')].filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.checkVisibility({ visibilityProperty: true }));
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="secondary" onClick={close} aria-label={`Закрыть: ${title}`}>Закрыть ×</button></div>
    {children}
  </dialog>;
}

export type Notice = { id: number; text: string; persistent: boolean };
export function Toast({ notice, dismiss }: { notice: Notice; dismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(5000);
  useEffect(() => {
    if (notice.persistent || hovered || focused) return;
    const started = Date.now();
    const timer = setTimeout(dismiss, remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [notice.persistent, hovered, focused, dismiss]);
  return <div className="toast" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <p role={notice.persistent ? 'alert' : 'status'}>{notice.text}</p><button type="button" className="secondary" aria-label="Закрыть уведомление" onClick={dismiss}>×</button>
  </div>;
}

export function ActionIcon({ kind }: { kind: 'connect' | 'select' | 'create' | 'delete' | 'settings' | 'archive' | 'statistics' }) {
  const paths = {
    connect: 'M10 7H3v14h18V7h-7M12 2v12M7 9l5 5 5-5',
    select: 'M3 5h18M5 12h14M8 19h8',
    create: 'M12 3v18M3 12h18',
    delete: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    settings: 'M4 3v18M12 3v18M20 3v18M1 8h6M9 16h6M17 8h6',
    statistics: 'M4 20V10M12 20V4M20 20v-7',
    archive: 'M4 7h16v14H4zM3 3h18v4H3zM9 11h6',
  };
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={paths[kind]} /></svg>;
}
