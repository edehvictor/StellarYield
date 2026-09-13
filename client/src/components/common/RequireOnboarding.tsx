import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useWallet } from "../../context/useWallet";
import { loadStoredSession, isSessionExpired } from "../../auth/session";

/**
 * Onboarding requirement levels for protected routes.
 *
 *  "wallet"  — user must have a connected, non-expired wallet session.
 *              Routes that need to read on-chain data or identify the user.
 *
 *  "network" — user must have a wallet connected on a recognised network.
 *              Routes that initiate transactions.
 *
 *  "profile" — user must have completed wallet + network setup AND have a
 *              verified session (verificationStatus === "verified").
 *              Routes that require full identity confirmation.
 */
export type OnboardingRequirement = "wallet" | "network" | "profile";

export interface RequireOnboardingProps {
  children: ReactNode;
  /** Minimum onboarding state required. Defaults to "wallet". */
  require?: OnboardingRequirement;
  /**
   * Where to redirect when the requirement is not met.
   * Defaults to "/" (the connect-wallet landing page).
   */
  redirectTo?: string;
}

/**
 * Derives the setup step the user needs to complete given the missing
 * requirement, so the redirect lands them on the right page.
 */
function resolveRedirect(
  missing: OnboardingRequirement,
  fallback: string,
): string {
  // In this app the home page (/) hosts wallet connection.
  // A "network" or "profile" gap can also be resolved there.
  if (missing === "wallet") return fallback;
  if (missing === "network") return fallback;
  if (missing === "profile") return fallback;
  return fallback;
}

/**
 * Route-level guard that redirects users to the appropriate onboarding
 * step when they haven't met the requirements for the requested route.
 *
 * Usage in the router:
 *
 *   <RequireOnboarding require="wallet">
 *     <PortfolioPage />
 *   </RequireOnboarding>
 *
 * Rules:
 *  1. If `isConnecting` is true the check is deferred — render nothing
 *     so the wallet restore completes before we redirect.
 *  2. If no session exists or the stored session is expired → redirect.
 *  3. For "network": additionally require that `network` is set.
 *  4. For "profile": additionally require verificationStatus === "verified".
 *  5. A redirect preserves the intended path via `state.from` so it can be
 *     restored after the user completes onboarding.
 */
export function RequireOnboarding({
  children,
  require: requirement = "wallet",
  redirectTo = "/",
}: RequireOnboardingProps) {
  const { isConnected, isConnecting, network, verificationStatus } =
    useWallet();
  const location = useLocation();

  // ── 1. Wallet is still restoring from storage — don't redirect yet ───
  if (isConnecting) {
    return null;
  }

  // ── 2. Wallet check ───────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <Navigate
        to={resolveRedirect("wallet", redirectTo)}
        state={{ from: location }}
        replace
      />
    );
  }

  // Double-check the stored session hasn't expired since the context
  // loaded it (the context does not continuously poll expiry).
  const storedSession = loadStoredSession();
  if (!storedSession || isSessionExpired(storedSession)) {
    return (
      <Navigate
        to={resolveRedirect("wallet", redirectTo)}
        state={{ from: location }}
        replace
      />
    );
  }

  // ── 3. Network check ──────────────────────────────────────────────────
  if (requirement === "network" || requirement === "profile") {
    if (!network) {
      return (
        <Navigate
          to={resolveRedirect("network", redirectTo)}
          state={{ from: location }}
          replace
        />
      );
    }
  }

  // ── 4. Profile / verification check ──────────────────────────────────
  if (requirement === "profile") {
    if (verificationStatus !== "verified") {
      return (
        <Navigate
          to={resolveRedirect("profile", redirectTo)}
          state={{ from: location }}
          replace
        />
      );
    }
  }

  // ── All checks passed — render the protected content ─────────────────
  return <>{children}</>;
}

export default RequireOnboarding;
