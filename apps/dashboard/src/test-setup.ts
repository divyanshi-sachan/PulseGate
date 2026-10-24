import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  // jsdom has no layout: charts render their table alternative; the SVG plot stays empty.
  class ResizeObserverStub {
    observe(): void {
      // No layout in jsdom: nothing to observe.
    }
    unobserve(): void {
      // Nothing observed.
    }
    disconnect(): void {
      // Nothing observed.
    }
  }
  Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub });
}

// Vitest globals are off, so Testing Library can't register its own cleanup. Node-environment tests
// (e.g. the token contrast check) have no window.
afterEach(() => {
  if (typeof window === 'undefined') return;
  cleanup();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/admin/ui/');
});
