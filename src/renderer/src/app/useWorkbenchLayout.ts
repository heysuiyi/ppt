import { type CSSProperties, type Dispatch, type SetStateAction, useEffect, useState } from "react";

import type { AppLocation } from "./appViewState";
export type ResizablePanel = "primary" | "secondary";

interface WorkbenchLayoutOptions {
  location: AppLocation;
  previewOpen: boolean;
  previewExpanded: boolean;
}

export interface WorkbenchLayoutController {
  isPrimarySidebarCollapsed: boolean;
  setIsPrimarySidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  togglePrimarySidebar: () => void;
  startPanelResize: (panel: ResizablePanel, startClientX: number) => void;
  workspaceClassName: string;
  workspaceStyle: CSSProperties;
}

const PRIMARY_MIN = 232;
const PRIMARY_MAX = 360;
const PRIMARY_DEFAULT = 280;
const PRIMARY_RAIL = 56;
const SECONDARY_MIN = 300;
const SECONDARY_MAX = 560;
const SECONDARY_DEFAULT = 380;
const MAIN_MIN = 560;
const PANEL_GUTTERS = 18;

function readStoredWidth(key: string, min: number, max: number, fallback: number): number {
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function useWorkbenchLayout({
  location,
  previewOpen,
  previewExpanded,
}: WorkbenchLayoutOptions): WorkbenchLayoutController {
  const activeMode =
    location.area === "settings" ? "settings" : location.page === "files" ? "files" : "workspace";
  const [isPrimarySidebarCollapsed, setIsPrimarySidebarCollapsed] = useState(
    () => window.localStorage.getItem("agent-ppt:primary-sidebar") === "collapsed",
  );
  const [primarySidebarWidth, setPrimarySidebarWidth] = useState(() =>
    readStoredWidth("agent-ppt:primary-sidebar-width", PRIMARY_MIN, PRIMARY_MAX, PRIMARY_DEFAULT),
  );
  const [secondaryPaneWidth, setSecondaryPaneWidth] = useState(() =>
    readStoredWidth(
      "agent-ppt:secondary-pane-width",
      SECONDARY_MIN,
      SECONDARY_MAX,
      SECONDARY_DEFAULT,
    ),
  );

  useEffect(() => {
    window.localStorage.setItem(
      "agent-ppt:primary-sidebar",
      isPrimarySidebarCollapsed ? "collapsed" : "expanded",
    );
  }, [isPrimarySidebarCollapsed]);

  useEffect(() => {
    window.localStorage.setItem("agent-ppt:primary-sidebar-width", String(primarySidebarWidth));
  }, [primarySidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem("agent-ppt:secondary-pane-width", String(secondaryPaneWidth));
  }, [secondaryPaneWidth]);

  useEffect(() => {
    if (activeMode !== "workspace" || !previewOpen || previewExpanded) return;
    const reconcilePanelWidths = () => {
      const expandedAvailable =
        window.innerWidth - primarySidebarWidth - secondaryPaneWidth - PANEL_GUTTERS;
      if (!isPrimarySidebarCollapsed && expandedAvailable < MAIN_MIN) {
        setIsPrimarySidebarCollapsed(true);
        return;
      }
      const effectivePrimaryWidth = isPrimarySidebarCollapsed ? PRIMARY_RAIL : primarySidebarWidth;
      const maxSecondaryWidth = Math.max(
        SECONDARY_MIN,
        Math.min(
          SECONDARY_MAX,
          window.innerWidth - effectivePrimaryWidth - MAIN_MIN - PANEL_GUTTERS,
        ),
      );
      setSecondaryPaneWidth((width) => Math.min(width, maxSecondaryWidth));
    };
    reconcilePanelWidths();
    window.addEventListener("resize", reconcilePanelWidths);
    return () => window.removeEventListener("resize", reconcilePanelWidths);
  }, [
    activeMode,
    isPrimarySidebarCollapsed,
    previewExpanded,
    previewOpen,
    primarySidebarWidth,
    secondaryPaneWidth,
  ]);

  const startPanelResize = (panel: ResizablePanel, startClientX: number) => {
    const startPrimaryWidth = primarySidebarWidth;
    const startSecondaryWidth = secondaryPaneWidth;
    document.documentElement.classList.add("is-resizing-panels");

    const handlePointerMove = (event: PointerEvent) => {
      if (panel === "primary") {
        setPrimarySidebarWidth(
          Math.min(
            PRIMARY_MAX,
            Math.max(PRIMARY_MIN, startPrimaryWidth + event.clientX - startClientX),
          ),
        );
        return;
      }
      const effectivePrimaryWidth = isPrimarySidebarCollapsed ? PRIMARY_RAIL : primarySidebarWidth;
      const availableWidth = window.innerWidth - effectivePrimaryWidth - MAIN_MIN - PANEL_GUTTERS;
      const maxWidth = Math.max(SECONDARY_MIN, Math.min(SECONDARY_MAX, availableWidth));
      setSecondaryPaneWidth(
        Math.min(
          maxWidth,
          Math.max(SECONDARY_MIN, startSecondaryWidth - (event.clientX - startClientX)),
        ),
      );
    };

    const handlePointerUp = () => {
      document.documentElement.classList.remove("is-resizing-panels");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const effectivePrimarySidebarWidth =
    activeMode !== "settings" && isPrimarySidebarCollapsed ? PRIMARY_RAIL : primarySidebarWidth;
  const workspaceStyle = {
    "--primary-sidebar-width": `${effectivePrimarySidebarWidth}px`,
    "--secondary-pane-width": `${secondaryPaneWidth}px`,
  } as CSSProperties;
  const workspaceClassName =
    `workspace-container mode-${activeMode}` +
    (activeMode !== "settings" && isPrimarySidebarCollapsed ? " primary-sidebar-collapsed" : "");

  return {
    isPrimarySidebarCollapsed,
    setIsPrimarySidebarCollapsed,
    togglePrimarySidebar: () => setIsPrimarySidebarCollapsed((collapsed) => !collapsed),
    startPanelResize,
    workspaceClassName,
    workspaceStyle,
  };
}
