import { IconButton } from "./Button";

interface PreviewNavigationProps {
  index: number;
  count: number;
  onNavigate: (delta: number) => void;
  label?: string;
  previousLabel?: string;
  nextLabel?: string;
  showPosition?: boolean;
  variant?: "toolbar" | "slideshow";
  className?: string;
}

export function PreviewNavigation({
  index,
  count,
  onNavigate,
  label = "页面导航",
  previousLabel = "选择上一页",
  nextLabel = "选择下一页",
  showPosition = false,
  variant = "toolbar",
  className,
}: PreviewNavigationProps) {
  return (
    <div
      className={["preview-navigation", `preview-navigation--${variant}`, className]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
    >
      <IconButton
        className={variant === "slideshow" ? "slideshow-nav-arrow left" : undefined}
        disabled={count === 0 || index <= 0}
        aria-label={previousLabel}
        onClick={(event) => {
          event.stopPropagation();
          onNavigate(-1);
        }}
      >
        ‹
      </IconButton>
      {showPosition && (
        <span className="preview-navigation-position">
          {count === 0 ? 0 : index + 1} / {count}
        </span>
      )}
      <IconButton
        className={variant === "slideshow" ? "slideshow-nav-arrow right" : undefined}
        disabled={count === 0 || index < 0 || index >= count - 1}
        aria-label={nextLabel}
        onClick={(event) => {
          event.stopPropagation();
          onNavigate(1);
        }}
      >
        ›
      </IconButton>
    </div>
  );
}
