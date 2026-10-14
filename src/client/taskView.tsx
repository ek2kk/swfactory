import { Component, createRef, type ReactNode } from 'react';

export type DescriptionDraft = { description: string; version: number; kind?: 'requirements' };
type Props = { blocked: boolean; hidden: boolean; children: ReactNode };

export class TaskView extends Component<Props, object, HTMLElement | null> {
  readonly container = createRef<HTMLDivElement>();
  private focused: HTMLElement | null = null;

  getSnapshotBeforeUpdate() {
    // Capture focus before React removes the old presentation, including an open dialog.
    const active = document.activeElement;
    const lostFocus = active === document.body && this.focused
      && (!this.focused.isConnected || this.focused.matches(':disabled'));
    if (this.props.hidden) return null;
    if (this.container.current?.contains(active)) return active as HTMLElement;
    return lostFocus ? this.focused : null;
  }

  componentDidUpdate(previous: Props, _state: object, focused: HTMLElement | null) {
    if (focused && (previous.blocked !== this.props.blocked || !focused.isConnected)) {
      this.container.current?.querySelector<HTMLElement>('[data-task-heading]')?.focus();
    }
  }

  render() {
    return <div ref={this.container} hidden={this.props.hidden} onFocusCapture={event => { this.focused = event.target as HTMLElement; }}>{this.props.children}</div>;
  }
}

// Preserve the visible event before React prepends new pages or messages.
export class HistoryFlow extends Component<{ children: ReactNode }, object, { id: string; top: number } | null> {
  readonly element = createRef<HTMLDivElement>();
  getSnapshotBeforeUpdate() {
    if (!this.element.current || this.element.current.getBoundingClientRect().top >= 0) return null;
    const anchor = [...this.element.current.querySelectorAll<HTMLElement>('[data-history-id]')]
      .find(element => element.getBoundingClientRect().bottom > 0);
    return anchor ? { id: anchor.dataset.historyId!, top: anchor.getBoundingClientRect().top } : null;
  }
  componentDidUpdate(_props: unknown, _state: unknown, anchor: { id: string; top: number } | null) {
    if (!anchor) return;
    const element = [...this.element.current!.querySelectorAll<HTMLElement>('[data-history-id]')].find(element => element.dataset.historyId === anchor.id);
    if (element) window.scrollBy(0, element.getBoundingClientRect().top - anchor.top);
  }
  render() { return <div ref={this.element} className="history-flow">{this.props.children}</div>; }
}
