import { hasUnverifiedCommercialAssets } from "@shared/asset-license";
import type { Presentation } from "@shared/presentation";
import { useCallback, useRef, useState } from "react";
import { confirmSvgExportExpectation } from "./exportExpectations";

export type DeckExportResult =
  | { status: "saved"; path: string }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown };

interface UseDeckExportOptions {
  sessionId: string;
  presentation: Presentation | undefined;
}

export function useDeckExport({ sessionId, presentation }: UseDeckExportOptions) {
  const [isExportingDeck, setIsExportingDeck] = useState(false);
  const exportingRef = useRef(false);

  const exportDeck = useCallback(
    async (onResult: (result: DeckExportResult) => void) => {
      if (!sessionId || !presentation || exportingRef.current) return;
      if (!confirmSvgExportExpectation(presentation)) return;
      const needsApproval = hasUnverifiedCommercialAssets(presentation);
      const allowUnverifiedAssets = needsApproval
        ? window.confirm("演示文稿包含尚未核实商业授权的图片。是否明确批准本次导出？")
        : false;
      if (needsApproval && !allowUnverifiedAssets) return;
      exportingRef.current = true;
      setIsExportingDeck(true);
      let result: DeckExportResult;
      try {
        const savedPath = await window.desktopApi.exportPresentation(sessionId, {
          allowUnverifiedAssets,
        });
        result = savedPath ? { status: "saved", path: savedPath } : { status: "cancelled" };
      } catch (error) {
        console.error("Export failed:", error);
        result = { status: "failed", error };
      } finally {
        exportingRef.current = false;
        setIsExportingDeck(false);
      }
      onResult(result);
    },
    [presentation, sessionId],
  );

  return { isExportingDeck, exportDeck };
}
