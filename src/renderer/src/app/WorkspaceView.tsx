import type { ComponentProps } from "react";
import { ChatWorkspace } from "../components/ChatWorkspace";
import { DeckPreviewModal } from "../components/DeckPreviewModal";
import { LeftPanel } from "../components/LeftPanel";
import { PPTMirror } from "../components/PPTMirror";
import { ProjectFilesPage } from "../components/ProjectFilesPage";
import type { AppLocation } from "./appViewState";
import type { ResizablePanel } from "./useWorkbenchLayout";

interface WorkspaceViewProps {
  state: Extract<AppLocation, { area: "workspace" }>;
  projectFilesProps: ComponentProps<typeof ProjectFilesPage>;
  leftPanelProps: Omit<
    ComponentProps<typeof LeftPanel>,
    "collapsed" | "onToggleCollapsed" | "page"
  >;
  chatWorkspaceProps: ComponentProps<typeof ChatWorkspace>;
  mirrorProps?: ComponentProps<typeof PPTMirror>;
  deckPreviewProps: ComponentProps<typeof DeckPreviewModal>;
  isSessionSwitching?: boolean;
  isMirrorVisible: boolean;
  isMirrorExpanded: boolean;
  isPrimarySidebarCollapsed: boolean;
  onTogglePrimarySidebar: () => void;
  onStartPanelResize: (panel: ResizablePanel, startClientX: number) => void;
}

export function WorkspaceView({
  state,
  projectFilesProps,
  leftPanelProps,
  chatWorkspaceProps,
  mirrorProps,
  deckPreviewProps,
  isSessionSwitching = false,
  isMirrorVisible,
  isMirrorExpanded,
  isPrimarySidebarCollapsed,
  onTogglePrimarySidebar,
  onStartPanelResize,
}: WorkspaceViewProps) {
  return (
    <>
      <div className="primary-sidebar-slot">
        <LeftPanel
          {...leftPanelProps}
          page={state.page}
          collapsed={isPrimarySidebarCollapsed}
          onToggleCollapsed={onTogglePrimarySidebar}
        />
      </div>

      {!isPrimarySidebarCollapsed ? (
        <div
          className="panel-resizer panel-resizer--primary"
          role="separator"
          aria-label="调整工作台侧栏宽度"
          aria-orientation="vertical"
          onPointerDown={(event) => {
            event.preventDefault();
            onStartPanelResize("primary", event.clientX);
          }}
        />
      ) : (
        <div className="panel-resizer-placeholder" />
      )}

      <div
        key={state.page}
        className="rounded-canvas workbench-main-surface view-enter"
        data-ui-region="canvas"
      >
        {state.page === "files" ? (
          <ProjectFilesPage {...projectFilesProps} />
        ) : (
          <>
            <div
              className={[
                "workspace-canvas-content",
                isMirrorVisible
                  ? "ppt-mirror-open"
                  : "ppt-mirror-closed workspace-canvas-content-chat-only",
                isMirrorVisible && isMirrorExpanded ? "mirror-expanded" : "",
                isSessionSwitching ? "is-session-switching" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-busy={isSessionSwitching || undefined}
            >
              <ChatWorkspace {...chatWorkspaceProps} />

              {isMirrorVisible && mirrorProps ? (
                <>
                  <div
                    className={`panel-resizer panel-resizer--secondary${isMirrorExpanded ? " is-disabled" : ""}`}
                    role="separator"
                    aria-label="调整预览面板宽度"
                    aria-orientation="vertical"
                    onPointerDown={(event) => {
                      if (isMirrorExpanded) return;
                      event.preventDefault();
                      onStartPanelResize("secondary", event.clientX);
                    }}
                  />
                  <PPTMirror {...mirrorProps} />
                </>
              ) : null}
            </div>

            <DeckPreviewModal {...deckPreviewProps} />
          </>
        )}
      </div>
    </>
  );
}
