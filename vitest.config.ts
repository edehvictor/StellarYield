export default {
  test: {
    projects: [
      {
        test: {
          name: 'sdk',
          environment: 'node',
          include: ['packages/sdk/**/*.{test,spec}.ts'],
          globals: true,
        },
      },
      {
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['client/src/**/*.{test,spec}.{ts,tsx}'],
          globals: true,
          setupFiles: [
            './client/vitest.setup.ts',
            './client/src/test-setup.ts',
          ],
        },
      },
    ],
  },
};
