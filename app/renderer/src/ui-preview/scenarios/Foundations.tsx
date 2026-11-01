import { useRef, useState } from "react";
import { Alert } from "../../ui/components/alert/Alert";
import { Button } from "../../ui/components/button/Button";
import { Dialog } from "../../ui/components/dialog/Dialog";
import { Field } from "../../ui/components/field/Field";
import { Input } from "../../ui/components/input/Input";
import { UiProvider } from "../../ui/provider/UiProvider";

function ThemeSample({ theme }: { theme: "light" | "dark" }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <UiProvider theme={theme}>
      <section
        className="ui-preview-theme-sample"
        aria-label={theme === "light" ? "浅色样例" : "深色样例"}
      >
        <h3>{theme === "light" ? "Light / 浅色" : "Dark / 深色"}</h3>
        <p>文字、边界、焦点与 Portal 使用同一主题。</p>
        <Field id={`sample-${theme}`} label="只读文本" hint="可选择与复制，不可修改。">
          {(props) => (
            <Input {...props} readOnly value="https://example.invalid/a/very-long-path" />
          )}
        </Field>
        <div className="ui-preview-actions">
          <Button ref={trigger} tone="primary" onClick={() => setOpen(true)}>
            打开{theme === "light" ? "浅色" : "深色"} Portal
          </Button>
          <Button disabled>禁用动作</Button>
        </div>
        <Alert title="区域反馈，不自动消失">必要信息留在当前上下文。</Alert>
        <Dialog
          open={open}
          purpose="content"
          title={theme === "light" ? "浅色 Portal 样例" : "深色 Portal 样例"}
          description="此模态挂在所属新 UI 根内，背景不可交互；关闭后回到触发按钮。"
          fallbackFocusRef={trigger}
          onRequestClose={() => setOpen(false)}
          footer={<Button onClick={() => setOpen(false)}>返回视觉基础</Button>}
        >
          <p>这是无草稿的内容预览，支持 Escape 和遮罩关闭。不会保存任何内容。</p>
          <p className="ui-preview-long">
            中文长内容 /
            https://example.invalid/preview/a-very-long-unbroken-address-that-must-wrap-without-making-the-page-overflow
          </p>
        </Dialog>
      </section>
    </UiProvider>
  );
}

export function Foundations() {
  return (
    <>
      <header className="ui-preview-page-heading">
        <p className="ui-preview-eyebrow">FOUNDATIONS / U1</p>
        <h1>视觉与作用域</h1>
        <p>同一组语义，不同主题。页面不覆盖组件内部尺寸。</p>
      </header>
      <div className="ui-preview-theme-grid">
        <ThemeSample theme="light" />
        <ThemeSample theme="dark" />
      </div>
      <section className="ui-preview-section">
        <h2>使用规则</h2>
        <dl className="ui-preview-rules">
          <div>
            <dt>字段错误 → Field</dt>
            <dd>有文本、有关联，提交后聚焦首个错误；不要仅弹 Toast。</dd>
          </div>
          <div>
            <dt>区域失败 → Alert</dt>
            <dd>输入保留，问题在原位持续可见；不要用计时消失掩盖失败。</dd>
          </div>
          <div>
            <dt>草稿离开 → 明确确认</dt>
            <dd>继续编辑保留内容，放弃后完成原来的关闭或切换。</dd>
          </div>
        </dl>
        <p className="ui-preview-meta">
          作用域外原生对照位于页面末尾。U3 的 Toast、选择与锚点浮层尚未实施。
        </p>
      </section>
    </>
  );
}
