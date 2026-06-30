import '@testing-library/jest-dom/vitest';
import '../src/i18n';

// jsdom does not implement ResizeObserver; provide a minimal stub.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
