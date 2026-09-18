import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeAgentSettings } from "./app/appBootstrap";
import "./styles.css";
import { installRendererErrorReporting } from "./logging";

installRendererErrorReporting();

const root = createRoot(document.getElementById("root")!);
initializeAgentSettings()
  .then(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    console.error("执行配置初始化失败", error);
    root.render(<main className="loading error">执行配置读取失败，请重启应用后重试。</main>);
  });
