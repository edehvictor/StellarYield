import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { WalletProvider } from "./context/WalletContext.tsx";
import { SettingsProvider } from "./features/settings/index.ts";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletProvider>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </WalletProvider>
  </StrictMode>,
);
