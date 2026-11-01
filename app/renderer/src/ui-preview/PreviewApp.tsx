import { useReducer, useRef, useState } from "react";
import { Alert } from "../ui/components/alert/Alert";
import { Button } from "../ui/components/button/Button";
import { UiProvider } from "../ui/provider/UiProvider";
import { ConnectionForm } from "./scenarios/ConnectionForm";
import { Foundations } from "./scenarios/Foundations";
import { connectionReducer, createConnectionState } from "./state/connection-state";

export function PreviewApp() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [state, dispatch] = useReducer(connectionReducer, undefined, () => createConnectionState());
  const fallback = useRef<HTMLButtonElement>(null);
  const selected = state.connections.find((item) => item.id === state.selectedId)!;
  return (
    <UiProvider theme={theme}>
      <div className="ui-preview-shell">
        <header className="ui-preview-toolbar">
          <div className="ui-preview-brand">
            <span className="ui-preview-mark" aria-hidden="true">
              U
            </span>
            <div>
              <strong>Interface Lab</strong>
              <p>UI 预览 / 本地演示，不连接后端</p>
            </div>
          </div>
          <div className="ui-preview-actions">
            <label className="ui-preview-theme-control">
              主题{" "}
              <select
                aria-label="预览主题"
                value={theme}
                onChange={(event) => setTheme(event.target.value as "light" | "dark")}
              >
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
            <Button onClick={() => dispatch({ type: "reset" })}>重置场景</Button>
          </div>
        </header>
        <div className="ui-preview-layout">
          <aside className="ui-preview-sidebar">
            <p className="ui-preview-eyebrow">第一轮 / U0–U2</p>
            <nav aria-label="预览场景" className="ui-preview-nav">
              <Button
                ref={fallback}
                aria-current={state.page === "connection" ? "page" : undefined}
                onClick={() =>
                  dispatch({ type: "leave", intent: { kind: "page", page: "connection" } })
                }
              >
                连接表单
              </Button>
              <Button
                aria-current={state.page === "foundations" ? "page" : undefined}
                onClick={() =>
                  dispatch({ type: "leave", intent: { kind: "page", page: "foundations" } })
                }
              >
                视觉与隔离
              </Button>
            </nav>
            <div className="ui-preview-sidebar-note">
              <strong>独立，不替换</strong>
              <p>无 Electron、模型调用、文件访问或真实凭据。刷新恢复固定数据。</p>
            </div>
          </aside>
          <main className="ui-preview-main">
            {state.page === "foundations" ? (
              <Foundations />
            ) : (
              <>
                <header className="ui-preview-page-heading">
                  <p className="ui-preview-eyebrow">LOCAL INTERACTION / U2</p>
                  <h1>连接表单</h1>
                  <p>先验证一条完整交互，再扩展组件和页面。</p>
                </header>
                <Alert title="只使用演示数据">
                  这是本地表单场景，不是模型配置。Key 仅接受公开常量 <code>demo-key</code>
                  ，不会保存凭据或验证远程连接。
                </Alert>
                <section className="ui-preview-section" aria-labelledby="connections-heading">
                  <div className="ui-preview-section-heading">
                    <div>
                      <h2 id="connections-heading">内置示例</h2>
                      <p>选择对象后编辑。成功只更新当前页面的内存基线。</p>
                    </div>
                    <span className="ui-preview-badge">仅本地</span>
                  </div>
                  <div className="ui-preview-connections">
                    {state.connections.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="ui-preview-connection"
                        aria-pressed={item.id === state.selectedId}
                        onClick={() =>
                          dispatch({ type: "leave", intent: { kind: "target", targetId: item.id } })
                        }
                      >
                        <span>{item.name}</span>
                        <code>{item.address}</code>
                        <small>{item.id === state.selectedId ? "当前对象" : "选择对象"}</small>
                      </button>
                    ))}
                  </div>
                  <div className="ui-preview-current">
                    <div>
                      <p className="ui-preview-meta">当前对象</p>
                      <strong>{selected.name}</strong>
                      <p className="ui-preview-long">{selected.address}</p>
                    </div>
                    <Button tone="primary" onClick={() => dispatch({ type: "open" })}>
                      编辑示例连接
                    </Button>
                  </div>
                  {state.notice && (
                    <Alert title="本地演示完成" tone="success" announce="polite">
                      {state.notice}
                    </Alert>
                  )}
                </section>
                <section className="ui-preview-section ui-preview-guide">
                  <h2>建议操作路径</h2>
                  <ol>
                    <li>编辑并清空名称，提交后查看首错定位。</li>
                    <li>填入演示值，选择本地失败并释放结果；输入应保留。</li>
                    <li>再次提交，或取消后继续编辑/放弃，验证草稿与焦点。</li>
                    <li>取消等待后重开，再释放旧结果；新编辑不应被覆盖。</li>
                  </ol>
                </section>
                <div className="ui-preview-actions">
                  <Button
                    disabled={!state.staleResults.length}
                    onClick={() => dispatch({ type: "complete", result: state.staleResults[0] })}
                  >
                    释放旧结果
                  </Button>
                  <p className="ui-preview-meta" role="status">
                    已失效结果 {state.staleResults.length} · 已忽略 {state.ignoredResults} · 世代{" "}
                    {state.generation}
                  </p>
                </div>
              </>
            )}
          </main>
        </div>
        <footer className="ui-preview-footer">
          U0 契约 / U1 独立视觉 / U2 表单闭环 · 不代表生产链路已迁移
        </footer>
      </div>
      {state.editor && (
        <ConnectionForm
          key={`${state.generation}:${state.editor.id}`}
          state={state}
          dispatch={dispatch}
          fallbackFocusRef={fallback}
        />
      )}
    </UiProvider>
  );
}
