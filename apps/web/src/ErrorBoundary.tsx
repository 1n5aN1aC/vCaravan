import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A throw during render or commit unmounts the whole tree, which is why a small
 * UI bug showed up as a blank page mid-match. The state itself is safe with the
 * table, so recovery is always just a reload.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('vCaravan UI crashed:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main>
        <h1>Something broke in the UI</h1>
        <p className="error">{this.state.error.message}</p>
        <p className="dim">
          Your seat is held at the table — reloading rejoins the match where it left off.
        </p>
        <button onClick={() => location.reload()}>Reload</button>
      </main>
    );
  }
}
