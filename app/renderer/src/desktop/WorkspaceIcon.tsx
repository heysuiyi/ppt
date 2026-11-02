export function WorkspaceIcon({
  name,
}: {
  name: "panel" | "plus" | "folder" | "settings" | "send";
}) {
  return (
    <svg
      className="ui-workspace-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "panel" && (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </>
      )}
      {name === "plus" && <path d="M12 5v14M5 12h14" />}
      {name === "folder" && <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3V7Z" />}
      {name === "settings" && (
        <>
          <path d="m9 4 .7-2h4.6l.7 2 2 1.2 2.1-.4 2.3 4-1.4 1.7v2.4l1.4 1.7-2.3 4-2.1-.4-2 1.2-.7 2H9l-.7-2-2-1.2-2.1.4-2.3-4 1.4-1.7v-2.4L1.9 8.8l2.3-4 2.1.4L9 4Z" />
          <circle cx="11.7" cy="11.7" r="3" />
        </>
      )}
      {name === "send" && <path d="M12 19V5m-6 6 6-6 6 6" />}
    </svg>
  );
}
