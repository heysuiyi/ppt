import { useRef, useState } from "react";
import { Alert } from "../../ui/components/alert/Alert";
import { Button } from "../../ui/components/button/Button";
import { Dialog } from "../../ui/components/dialog/Dialog";
import { Field } from "../../ui/components/field/Field";
import { Input } from "../../ui/components/input/Input";
import { Select, type SelectOption } from "../../ui/components/select/Select";
import { UiProvider, type UiTheme } from "../../ui/provider/UiProvider";
import "./foundations.css";

const nativeComparison = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; form-action 'none'; base-uri 'none'">
<title>原生样式对照</title></head><body>
<p><label>原生输入 <input value="未应用 UI 样式" readonly></label></p>
<button disabled>原生禁用按钮</button>
</body></html>`;

const selectOptions: readonly SelectOption[] = [
  { value: "overview", label: "中文概览 / 工作区与当前会话" },
  { value: "archive", label: "已归档 / 不可选择", disabled: true },
  { value: "assets", label: "Assets / shared illustrations" },
  { value: "brief", label: "Brief / 项目说明" },
  { value: "charts", label: "Charts / 数据图表" },
  { value: "design", label: "Design / 设计规范" },
  { value: "examples", label: "Examples / 参考样例" },
  { value: "fonts", label: "Fonts / 字体资源" },
  { value: "guides", label: "Guides / 使用指南" },
  { value: "history", label: "History / 历史版本" },
  { value: "images", label: "Images / 图片素材" },
  { value: "layouts", label: "Layouts / 页面布局" },
  { value: "notes", label: "Notes / 本地笔记" },
  {
    value: "project-path",
    label:
      "Projects / workspace/preview/collections/a-very-long-english-directory-name/component-inspection/theme-and-portal/select-options",
  },
  { value: "reports", label: "Reports / 检查报告" },
  { value: "samples", label: "Samples / 组件样例" },
  { value: "templates", label: "Templates / 页面模板" },
  { value: "versions", label: "Versions / 版本列表" },
  { value: "workspace", label: "Workspace / 当前工作区" },
  { value: "end", label: "中文末项 / 列表结束" },
];

function ThemeSample({ theme }: { theme: UiTheme }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("overview");
  const [disabledValue, setDisabledValue] = useState("archive");
  const [modalValue, setModalValue] = useState("project-path");
  const trigger = useRef<HTMLButtonElement>(null);
  const themeLabel = theme === "light" ? "浅色" : "深色";
  return (
    <UiProvider theme={theme}>
      <section className="ui-foundations-sample" aria-label={`${themeLabel}样例`}>
        <h2>{themeLabel}</h2>
        <Field id={`sample-${theme}`} label="只读文本">
          {(props) => (
            <Input {...props} readOnly value="https://example.invalid/a/very-long-path" />
          )}
        </Field>
        <Field id={`sample-${theme}-disabled`} label="禁用输入">
          {(props) => <Input {...props} disabled value="不可编辑" />}
        </Field>
        <Field
          id={`sample-${theme}-select`}
          label={`${themeLabel}样例选择`}
          hint={`当前值：${value}。可滚动，或用 Home / End、字母定位。`}
        >
          {({ id, "aria-describedby": describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={value}
              onValueChange={setValue}
              options={selectOptions}
            />
          )}
        </Field>
        <Field
          id={`sample-${theme}-select-disabled`}
          label={`${themeLabel}禁用选择`}
          hint="保留已归档值，触发器不可操作。"
        >
          {({ id, "aria-describedby": describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              disabled
              value={disabledValue}
              onValueChange={setDisabledValue}
              options={selectOptions}
            />
          )}
        </Field>
        <div className="ui-foundations-actions">
          <Button ref={trigger} tone="primary" onClick={() => setOpen(true)}>
            打开{themeLabel} Portal
          </Button>
          <Button disabled>禁用动作</Button>
        </div>
        <Alert title="区域反馈">内容保留在当前区域。</Alert>
        <Dialog
          open={open}
          purpose="content"
          title={`${themeLabel} Portal 样例`}
          description="检查所属主题、长内容与关闭后的焦点。"
          fallbackFocusRef={trigger}
          onRequestClose={() => setOpen(false)}
          footer={<Button onClick={() => setOpen(false)}>关闭</Button>}
        >
          <p>展开选择后，Escape 先收起列表，再按一次关闭弹窗。</p>
          <Field
            id={`sample-${theme}-modal-select`}
            label={`${themeLabel}模态选择`}
            hint={`当前值：${modalValue}。列表应保持当前弹窗主题。`}
          >
            {({ id, "aria-describedby": describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={modalValue}
                onValueChange={setModalValue}
                options={selectOptions}
              />
            )}
          </Field>
          <p className="ui-foundations-long">
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
    <div className="ui-foundations">
      <header className="ui-foundations-heading">
        <h1>组件与样式</h1>
        <p>检查主题、输入状态与 Portal；原生对照使用独立文档。</p>
      </header>
      <div className="ui-foundations-grid">
        <ThemeSample theme="light" />
        <ThemeSample theme="dark" />
      </div>
      <section className="ui-foundations-native" aria-labelledby="native-comparison-title">
        <h2 id="native-comparison-title">原生样式对照</h2>
        <iframe title="原生样式对照" sandbox="" srcDoc={nativeComparison} />
      </section>
    </div>
  );
}
