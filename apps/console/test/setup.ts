import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// What the components use and jsdom does not have.
const provide = (target: object, name: string, value: unknown) => {
  if (!(name in target)) {
    Object.defineProperty(target, name, { value, writable: true, configurable: true });
  }
};

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
provide(globalThis, 'ResizeObserver', NoopObserver);
provide(window, 'matchMedia', (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
}));
provide(Element.prototype, 'scrollIntoView', () => {});
provide(Element.prototype, 'hasPointerCapture', () => false);
provide(Element.prototype, 'setPointerCapture', () => {});
provide(Element.prototype, 'releasePointerCapture', () => {});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});
