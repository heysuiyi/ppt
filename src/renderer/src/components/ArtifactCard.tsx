import type { ComponentPropsWithoutRef, ReactNode } from "react";

type CardProps = ComponentPropsWithoutRef<"div">;

export function ArtifactCard({ className = "", ...props }: CardProps) {
  return <div {...props} className={`artifact-card ${className}`.trim()} />;
}

export function CardHeader({
  badge,
  title,
  children,
  className = "",
}: {
  badge: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`artifact-card-header ${className}`.trim()}>
      <span className="artifact-card-badge">{badge}</span>
      <span className="artifact-card-title">{title}</span>
      {children}
    </div>
  );
}

export function CardActions({ className = "", ...props }: CardProps) {
  return <div {...props} className={`artifact-card-actions ${className}`.trim()} />;
}
