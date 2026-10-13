import { Component, createRef, type ReactNode } from 'react';

export type DescriptionDraft = { description: string; version: number };
type Props = { blocked: boolean; hidden: boolean; children: ReactNode };

export class TaskView extends Component<Props, object, boolean> {
  readonly container = createRef<HTMLDivElement>();
  private focused: HTMLElement | null = null;

  getSnapshotBeforeUpdate(previous: Props) {
    // Capture focus before React removes the old presentation, including an open dialog.
    const active = document.activeElement;
    const lostFocus = active === document.body && this.focused
      && (!this.focused.isConnected || this.focused.matches(':disabled'));
    return previous.blocked !== this.props.blocked && !this.props.hidden
      && (!!this.container.current?.contains(active) || !!lostFocus);
  }

  componentDidUpdate(_previous: Props, _state: object, restoreFocus: boolean) {
    if (restoreFocus) this.container.current?.querySelector<HTMLElement>('[data-task-heading]')?.focus();
  }

  render() {
    return <div ref={this.container} hidden={this.props.hidden} onFocusCapture={event => { this.focused = event.target as HTMLElement; }}>{this.props.children}</div>;
  }
}
