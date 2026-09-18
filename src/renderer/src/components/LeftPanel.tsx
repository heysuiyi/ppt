import type { SessionSummary } from "@shared/session";
import { getWorkspaceLabel, groupSessionsByWorkspace } from "@shared/workspace";
import React from "react";
import type { WorkspacePage } from "../app/appViewState";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SidebarPanelIcon,
  TrashIcon,
} from "./Icons";

interface LeftPanelProps {
  sessions: SessionSummary[];
  activeSessionId: string;
  page: WorkspacePage;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onNewSessionInWorkspace: (workspacePath: string) => void;
  onOpenWorkspace: () => void;
  onOpenFiles: () => void;
  onToggleSettings: () => void;
  onDeleteSession: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function SessionRow({
  session,
  isActive,
  onSelect,
  onContextMenu,
}: {
  session: SessionSummary;
  isActive: boolean;
  onSelect: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className={`session-row ${isActive ? "active" : ""}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={session.title}
    >
      <span className="session-title">{session.title}</span>
    </button>
  );
}

function WorkspaceSection({
  workspaceKey,
  workspaceSessions,
  activeSessionId,
  onNewSessionInWorkspace,
  onSelectSession,
  onContextMenu,
}: {
  workspaceKey: string;
  workspaceSessions: SessionSummary[];
  activeSessionId: string;
  onNewSessionInWorkspace: (workspacePath: string) => void;
  onSelectSession: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, sessionId: string) => void;
}) {
  const label = getWorkspaceLabel(workspaceKey);
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const toggleCollapsed = () => setIsCollapsed((value) => !value);

  return (
    <div className="workspace-section">
      <div
        className="workspace-header"
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        title={workspaceKey}
        onClick={toggleCollapsed}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleCollapsed();
          }
        }}
      >
        <FolderIcon size={14} className="workspace-icon" />
        <span className="workspace-label">{label}</span>
        <span
          className="workspace-toggle-btn"
          title={isCollapsed ? "打开文件夹" : "折叠文件夹"}
          aria-hidden="true"
        >
          {isCollapsed ? <ChevronRightIcon size={14} /> : <ChevronDownIcon size={14} />}
        </span>
        <button
          type="button"
          className="workspace-add-btn"
          title="在此目录下新建会话"
          onClick={(event) => {
            event.stopPropagation();
            onNewSessionInWorkspace(workspaceKey);
          }}
        >
          <PlusIcon size={14} />
        </button>
      </div>
      {!isCollapsed ? (
        <div className="session-list">
          {workspaceSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isActive={activeSessionId === session.id}
              onSelect={() => onSelectSession(session.id)}
              onContextMenu={(event) => onContextMenu(event, session.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const LeftPanel: React.FC<LeftPanelProps> = ({
  sessions,
  activeSessionId,
  page,
  onSelectSession,
  onNewSession,
  onNewSessionInWorkspace,
  onOpenWorkspace,
  onOpenFiles,
  onToggleSettings,
  onDeleteSession,
  collapsed,
  onToggleCollapsed,
}) => {
  const [contextMenu, setContextMenu] = React.useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);
  const [isSearchOpen, setIsSearchOpen] = React.useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState("");
  const searchAreaRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (isSearchOpen) {
      searchInputRef.current?.focus();
    }
  }, [isSearchOpen]);

  React.useEffect(() => {
    if (!isSearchOpen) return;

    const closeSearch = () => {
      setIsSearchOpen(false);
      setSessionSearchQuery("");
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (searchAreaRef.current?.contains(target)) return;
      closeSearch();
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (searchAreaRef.current?.contains(target)) return;
      closeSearch();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [isSearchOpen]);

  const visibleSessions = React.useMemo(() => {
    const query = sessionSearchQuery.trim().toLowerCase();
    if (!query) return sessions;

    return sessions.filter((session) => {
      const titleMatches = session.title.toLowerCase().includes(query);
      const workspacePath = session.workspacePath ?? "";
      const workspaceLabel = getWorkspaceLabel(workspacePath).toLowerCase();
      const workspaceMatches =
        workspacePath.toLowerCase().includes(query) || workspaceLabel.includes(query);

      return titleMatches || workspaceMatches;
    });
  }, [sessions, sessionSearchQuery]);

  const groupedSessions = React.useMemo(
    () => groupSessionsByWorkspace(visibleSessions),
    [visibleSessions],
  );
  const workspaceGroups = groupedSessions.filter((group) => group.workspacePath !== "__unknown__");
  const orphanSessions =
    groupedSessions.find((group) => group.workspacePath === "__unknown__")?.sessions ?? [];
  const hasSessionList = visibleSessions.length > 0;

  React.useEffect(() => {
    const handleClose = () => setContextMenu(null);
    window.addEventListener("click", handleClose);
    return () => window.removeEventListener("click", handleClose);
  }, []);

  const handleContextMenu = (event: React.MouseEvent, sessionId: string) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, sessionId });
  };

  if (collapsed) {
    return (
      <aside
        className="left-panel workbench-sidebar workbench-sidebar--rail"
        data-ui-region="sidebar"
        aria-label="折叠的工作台导航"
      >
        <div className="sidebar-brand-mark" title="Agent PPT" aria-label="Agent PPT">
          <img src="./icon.png" alt="" />
        </div>
        <button
          type="button"
          className="sidebar-rail-btn"
          onClick={onToggleCollapsed}
          title="展开导航"
          aria-label="展开导航"
        >
          <SidebarPanelIcon size={17} />
        </button>
        <button
          type="button"
          className="sidebar-rail-btn"
          onClick={onNewSession}
          title="新建会话"
          aria-label="新建会话"
        >
          <PlusIcon size={17} />
        </button>
        <button
          type="button"
          className={`sidebar-rail-btn${page === "chat" ? " active" : ""}`}
          onClick={onOpenWorkspace}
          title="Agent 工作区"
          aria-label="Agent 工作区"
          aria-current={page === "chat" ? "page" : undefined}
        >
          <FolderIcon size={17} />
        </button>
        <button
          type="button"
          className={`sidebar-rail-btn${page === "files" ? " active" : ""}`}
          onClick={onOpenFiles}
          title="项目文件"
          aria-label="项目文件"
          aria-current={page === "files" ? "page" : undefined}
        >
          <FileIcon size={17} />
        </button>
        <div className="sidebar-rail-spacer" />
        <button
          type="button"
          className="sidebar-rail-btn"
          onClick={onToggleSettings}
          title="设置"
          aria-label="设置"
        >
          <SettingsIcon size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="left-panel workbench-sidebar" data-ui-region="sidebar">
      <div className="workbench-sidebar-top">
        <div className="workbench-sidebar-heading">
          <div className="workbench-sidebar-brand">
            <img src="./icon.png" alt="" />
            <span>Agent PPT</span>
          </div>
        </div>
        <button type="button" className="workbench-sidebar-action-row" onClick={onNewSession}>
          <PlusIcon size={14} className="workspace-icon" />
          <span>新建会话</span>
        </button>
        <button
          type="button"
          className={`workbench-sidebar-action-row${page === "chat" ? " active" : ""}`}
          onClick={onOpenWorkspace}
          aria-current={page === "chat" ? "page" : undefined}
        >
          <FolderIcon size={14} className="workspace-icon" />
          <span>Agent 工作区</span>
        </button>
        <button
          type="button"
          className={`workbench-sidebar-action-row${page === "files" ? " active" : ""}`}
          onClick={onOpenFiles}
          aria-current={page === "files" ? "page" : undefined}
        >
          <FileIcon size={14} className="workspace-icon" />
          <span>项目文件</span>
        </button>
        <div ref={searchAreaRef}>
          <button
            type="button"
            className={`workbench-sidebar-action-row ${isSearchOpen ? "active" : ""}`}
            onClick={() => setIsSearchOpen((value) => !value)}
          >
            <SearchIcon size={14} className="workspace-icon" />
            <span>搜索会话</span>
          </button>
          {isSearchOpen ? (
            <input
              ref={searchInputRef}
              className="workbench-sidebar-search-input"
              value={sessionSearchQuery}
              placeholder="输入关键词"
              onChange={(event) => setSessionSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSessionSearchQuery("");
                  setIsSearchOpen(false);
                }
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="workbench-sidebar-list">
        <div className="workbench-sidebar-section-label">项目</div>
        {hasSessionList ? (
          <>
            {orphanSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                isActive={activeSessionId === session.id}
                onSelect={() => onSelectSession(session.id)}
                onContextMenu={(event) => handleContextMenu(event, session.id)}
              />
            ))}
            {workspaceGroups.map((group) => (
              <WorkspaceSection
                key={group.workspacePath}
                workspaceKey={group.workspacePath}
                workspaceSessions={group.sessions}
                activeSessionId={activeSessionId}
                onNewSessionInWorkspace={onNewSessionInWorkspace}
                onSelectSession={onSelectSession}
                onContextMenu={handleContextMenu}
              />
            ))}
          </>
        ) : (
          <div className="workbench-sidebar-empty">
            {sessionSearchQuery.trim() ? "没有找到匹配会话" : "暂无会话"}
          </div>
        )}
      </div>

      <div className="panel-footer left-footer flex justify-between items-center">
        <button
          type="button"
          className="settings-nav-back"
          onClick={onToggleSettings}
          title="设置"
          aria-label="打开设置"
        >
          <SettingsIcon size={14} />
          <span>设置</span>
        </button>
      </div>

      {contextMenu ? (
        <div
          className="custom-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            className="custom-context-menu-item danger"
            onClick={(event) => {
              event.stopPropagation();
              setContextMenu(null);
              onDeleteSession(contextMenu.sessionId);
            }}
          >
            <TrashIcon size={14} />
            <span>删除会话</span>
          </div>
        </div>
      ) : null}
    </aside>
  );
};
