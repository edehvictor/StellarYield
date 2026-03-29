import { useEffect } from "react";
import { buildVaultOgImagePath } from "../utils/vaultOg";

/**
 * Injects / updates Open Graph and Twitter image meta tags in document head for vault pages.
 * Tags are removed on unmount so other routes do not keep a stale preview image.
 */
export function useVaultOgMeta(vault: string): void {
  useEffect(() => {
    const content = buildVaultOgImagePath(vault);

    const og = document.createElement("meta");
    og.setAttribute("property", "og:image");
    og.setAttribute("content", content);
    og.setAttribute("data-stellaryield-vault-og", "1");
    document.head.appendChild(og);

    const tw = document.createElement("meta");
    tw.setAttribute("name", "twitter:image");
    tw.setAttribute("content", content);
    tw.setAttribute("data-stellaryield-vault-og", "1");
    document.head.appendChild(tw);

    return () => {
      og.remove();
      tw.remove();
    };
  }, [vault]);
}
