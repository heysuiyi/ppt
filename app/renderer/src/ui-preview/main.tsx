import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PreviewApp } from "./PreviewApp";
import "../ui/styles.css";
import "./preview.css";

const root = document.getElementById("ui-preview-root");
if (!root) throw new Error("UI preview root is missing");
createRoot(root).render(
  <StrictMode>
    <PreviewApp />
  </StrictMode>,
);
