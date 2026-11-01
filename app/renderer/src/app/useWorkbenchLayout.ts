import {
  type CSSProperties,
  type Dispatch,
  type RefCallback,
  type SetStateAction,
  useEffect,
  useState,
} from "react";

import type { ResizeHandleProps } from "../components/ResizeHandle";
import type { AppLocation } from "./appViewState";
export type PanelResizeControl = Pick<ResizeHandleProps, "value" | "min" | "max" | "onValueChange">;

interface WorkbenchLayoutOptions {
  location: AppLocation;
  previewOpen: boolean;
  previewExpanded: boolean;
}

export interface WorkbenchLayoutController {
  isPrimarySidebarCollapsed: boolean;
  setIsPrimarySidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  togglePrimarySidebar: () => void;
  primaryResize: PanelResizeControl;
  secondaryResize: PanelResizeControl;
  workspaceRef: RefCallback<HTMLDivElement>;
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
const PANEL_RESIZER_WIDTH = 6;

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
  const [workspaceElement, setWorkspaceElement] = useState<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
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
    if (!workspaceElement) return;
    const measure = () => {
      const style = getComputedStyle(workspaceElement);
      setContainerWidth(
        workspaceElement.clientWidth -
          Number.parseFloat(style.paddingLeft || "0") -
          Number.parseFloat(style.paddingRight || "0"),
      );
    };
    measure();
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(workspaceElement);
    return () => observer.disconnect();
  }, [workspaceElement]);

  const hasPreview = activeMode === "workspace" && previewOpen && !previewExpanded;
  const requestedPrimaryWidth =
    activeMode !== "settings" && isPrimarySidebarCollapsed ? PRIMARY_RAIL : primarySidebarWidth;
  const effectivePrimarySidebarWidth =
    containerWidth > 0
      ? Math.min(requestedPrimaryWidth, containerWidth * 0.4)
      : requestedPrimaryWidth;
  const availableCanvasWidth = Math.max(
    0,
    containerWidth - effectivePrimarySidebarWidth - PANEL_RESIZER_WIDTH * 2,
  );
  const maxSecondaryWidth = Math.min(
    SECONDARY_MAX,
    Math.max(0, availableCanvasWidth - Math.min(MAIN_MIN, availableCanvasWidth * 0.6)),
  );
  const effectiveSecondaryPaneWidth =
    containerWidth > 0 ? Math.min(secondaryPaneWidth, maxSecondaryWidth) : secondaryPaneWidth;
  const maxPrimaryWidth =
    containerWidth > 0 ? Math.min(PRIMARY_MAX, containerWidth * 0.4) : PRIMARY_MAX;

  useEffect(() => {
    if (
      hasPreview &&
      containerWidth > 0 &&
      !isPrimarySidebarCollapsed &&
      containerWidth - primarySidebarWidth - secondaryPaneWidth - PANEL_RESIZER_WIDTH * 2 < MAIN_MIN
    ) {
      setIsPrimarySidebarCollapsed(true);
    }
  }, [
    containerWidth,
    hasPreview,
    isPrimarySidebarCollapsed,
    primarySidebarWidth,
    secondaryPaneWidth,
  ]);

  const workspaceStyle = {
    "--primary-sidebar-width": `${effectivePrimarySidebarWidth}px`,
    "--secondary-pane-width": `${effectiveSecondaryPaneWidth}px`,
  } as CSSProperties;
  const workspaceClassName =
    `workspace-container mode-${activeMode}` +
    (activeMode !== "settings" && isPrimarySidebarCollapsed ? " primary-sidebar-collapsed" : "");

  return {
    isPrimarySidebarCollapsed,
    setIsPrimarySidebarCollapsed,
    togglePrimarySidebar: () => setIsPrimarySidebarCollapsed((collapsed) => !collapsed),
    primaryResize: {
      value: effectivePrimarySidebarWidth,
      min: Math.min(PRIMARY_MIN, maxPrimaryWidth),
      max: maxPrimaryWidth,
      onValueChange: setPrimarySidebarWidth,
    },
    secondaryResize: {
      value: effectiveSecondaryPaneWidth,
      min: Math.min(SECONDARY_MIN, maxSecondaryWidth),
      max: maxSecondaryWidth,
      onValueChange: setSecondaryPaneWidth,
    },
    workspaceRef: setWorkspaceElement,
    workspaceClassName,
    workspaceStyle,
  };
}
