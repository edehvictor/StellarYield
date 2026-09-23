/**
 * Vitest Setup - Mock browser APIs for Node.js environment
 */

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

// Make localStorage available globally in Node.js environment
if (typeof global !== "undefined" && !global.localStorage) {
  (global as any).localStorage = localStorageMock;
}

// Mock ResizeObserver for Recharts and ResponsiveContainer
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof global !== "undefined" && !global.ResizeObserver) {
  (global as any).ResizeObserver = ResizeObserverMock;
  if (typeof window !== "undefined") {
    (window as any).ResizeObserver = ResizeObserverMock;
  }
}

// Mock IntersectionObserver
class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof global !== "undefined" && !global.IntersectionObserver) {
  (global as any).IntersectionObserver = IntersectionObserverMock;
  if (typeof window !== "undefined") {
    (window as any).IntersectionObserver = IntersectionObserverMock;
  }
}
