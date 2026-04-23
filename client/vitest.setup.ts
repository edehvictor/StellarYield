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
