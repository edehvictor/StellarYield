# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/)

## Wallet lifecycle & operation recovery

Wallet sessions are persisted in `localStorage` under `stellar-yield.wallet-session`. To make partially completed wallet operations safe to retry, the session record can carry an optional `pendingOperation` field:

```ts
interface WalletOperationState {
  operationId: string;
  action: string;
  walletAddress: string;
  phase: "pending" | "signed" | "submitted" | "confirmed" | "failed" | "rolled_back";
  payload?: string;
  txHash?: string;
  attempts: number;
  updatedAt: string;
  lastError?: string;
}
```

Use the helpers in `src/auth/session.ts` to manage it:

- `saveOperationState(op)` — persist the latest committed phase. Existing session fields and balances are preserved.
- `loadOperationState()` — read the persisted operation for safe resume.
- `clearOperationState()` — roll back the operation without clearing the session.

When an operation fails or the session expires mid-flight, the persisted phase is retained so the UI can offer a safe retry (`SessionExpiredRecovery`) without re-signing or double-submitting.

## React Compiler

The React Compiler is not enabled in this template because of its impact on dev & build performance. To add it, see this [documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this if you do not want type-aware lint rules:
      // tseslint.configs.recommended,
      // Alternatively, use this for stricter rules:
      tseslint.configs.strictTypeChecked,
      // Optionally, use this for stylistic rules:
      // tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1Cx/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1Cx/eslint-plugin-react-dom) for React-specific lint rules:

```js

// eslint.config.js

import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules
      reactX.configs.recommended,
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: [' ./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
