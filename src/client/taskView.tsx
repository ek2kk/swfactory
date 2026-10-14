import { Component, createRef, type ReactNode } from 'react';

export type DescriptionDraft = { description: string; version: number };
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
