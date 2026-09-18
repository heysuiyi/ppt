// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import { WorkspaceView } from "../src/renderer/src/app/WorkspaceView";
import type { ChatWorkspaceProps } from "../src/renderer/src/components/ChatWorkspace";

vi.mock("../src/renderer/src/components/LeftPanel", () => ({
  LeftPanel: ({ page }: { page: string }) => (
    <aside>
      <input aria-label="menu search" />
      <span>{page}</span>
    </aside>
  ),
}));
vi.mock("../src/renderer/src/components/ChatWorkspace", () => ({
  ChatWorkspace: () => <div data-testid="chat">Chat</div>,
}));
vi.mock("../src/renderer/src/components/ProjectFilesPage", () => ({
  ProjectFilesPage: () => <input aria-label="file editor" />,
}));
vi.mock("../src/renderer/src/components/PPTMirror", () => ({ PPTMirror: () => <div>Mirror</div> }));
vi.mock("../src/renderer/src/components/DeckPreviewModal", () => ({
  DeckPreviewModal: () => <div data-testid="preview" />,
}));

afterEach(cleanup);

function workspaceProps(isNewChat: boolean): ChatWorkspaceProps {
  return {
    session: {
      id: isNewChat ? "" : "session-1",
      conversationTitle: isNewChat ? undefined : "季度复盘",
      messages: isNewChat ? [] : [{ id: "user-1", role: "user", content: "季度复盘" }],
    },
    run: {
      activityTrace: [],
      phase: "idle",
      busy: false,
    },
    composer: {
      request: "",
      onChangeRequest: vi.fn(),
      onSubmitRequest: vi.fn(),
      models: [],
      selectedModelId: "",
      onSelectModel: vi.fn(),
      workspacePath: "",
      onPrepareWorkspace: vi.fn(),
      onProposePrompt: vi.fn(),
    },
    deck: {
      isMirrorOpen: false,
      onToggleMirror: vi.fn(),
      onOpenPreview: vi.fn(),
      onExport: vi.fn(),
    },
    actions: {
      onResolveApproval: vi.fn(),
      onResolvePatch: vi.fn(),
      onResolveQuestion: vi.fn(),
      onReviseOutline: vi.fn(),
      onUpdateMessageContent: vi.fn(),
      notify: vi.fn(),
    },
  };
}

function props(): ComponentProps<typeof WorkspaceView> {
  return {
    state: { area: "workspace", page: "chat" },
    leftPanelProps: {
      sessions: [],
      activeSessionId: "",
      onSelectSession: vi.fn(),
      onNewSession: vi.fn(),
      onNewSessionInWorkspace: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onOpenFiles: vi.fn(),
      onToggleSettings: vi.fn(),
      onDeleteSession: vi.fn(),
    },
    projectFilesProps: { sessionTitle: "", workspaceLabel: "", busy: false, notify: vi.fn() },
    chatWorkspaceProps: workspaceProps(true),
    deckPreviewProps: {
      open: false,
      presentation: {
        id: "",
        title: "",
        revision: 0,
        designSystem: DEFAULT_DESIGN_SYSTEM,
        slides: [],
      },
      onSelectSlide: vi.fn(),
      onClose: vi.fn(),
    },
    isMirrorVisible: false,
    isMirrorExpanded: false,
    isPrimarySidebarCollapsed: false,
    onTogglePrimarySidebar: vi.fn(),
    onStartPanelResize: vi.fn(),
  };
}

describe("workspace region", () => {
  it("preserves the shared menu while replacing chat and file content", () => {
    const initial = props();
    const view = render(<WorkspaceView {...initial} />);
    const menu = screen.getByLabelText("menu search");
    fireEvent.change(menu, { target: { value: "project filter" } });
    view.rerender(<WorkspaceView {...initial} state={{ area: "workspace", page: "files" }} />);
    expect(screen.getByLabelText("menu search")).toBe(menu);
    expect((menu as HTMLInputElement).value).toBe("project filter");
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(screen.queryByTestId("preview")).toBeNull();
    expect(screen.getByLabelText("file editor")).toBeTruthy();
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    view.rerender(<WorkspaceView {...initial} />);
    expect(screen.getByLabelText("menu search")).toBe(menu);
    expect(screen.queryByLabelText("file editor")).toBeNull();
    expect(screen.getByTestId("chat")).toBeTruthy();
  });

  it("unmounts file editor drafts after an authorized departure", () => {
    const initial = props();
    const files = {
      ...initial,
      state: { area: "workspace", page: "files" },
    } satisfies ComponentProps<typeof WorkspaceView>;
    const view = render(<WorkspaceView {...files} />);
    fireEvent.change(screen.getByLabelText("file editor"), { target: { value: "discarded" } });
    view.rerender(<WorkspaceView {...initial} />);
    view.rerender(<WorkspaceView {...files} />);
    expect((screen.getByLabelText("file editor") as HTMLInputElement).value).toBe("");
  });
});
