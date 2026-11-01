import type React from "react";

interface ResolvedCardProps {
  label: string;
  title: string;
  detail?: string;
  children?: React.ReactNode;
}

export const ResolvedCard: React.FC<ResolvedCardProps> = ({ label, title, detail, children }) => (
  <details className="resolved-card">
    <summary className="resolved-card-summary">
      <span className="resolved-card-check" aria-hidden="true">
        ✓
      </span>
      <span className="resolved-card-copy">
        <span className="resolved-card-label">{label}</span>
        <strong>{title}</strong>
      </span>
      {detail && <span className="resolved-card-detail">{detail}</span>}
      {children && <span className="resolved-card-disclosure">查看</span>}
    </summary>
    {children && <div className="resolved-card-body">{children}</div>}
  </details>
);
