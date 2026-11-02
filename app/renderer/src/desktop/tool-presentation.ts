const toolLabels: Readonly<Record<string, string>> = {
  read: "读取",
  glob: "查找文件",
  grep: "搜索内容",
  write: "写入文件",
  edit: "编辑文件",
};

export function getToolLabel(name: string): string {
  return Object.hasOwn(toolLabels, name) ? toolLabels[name] : name;
}

export function getToolSummary(name: string): string {
  if (name === "read") return "读取文件";
  return Object.hasOwn(toolLabels, name) ? toolLabels[name] : "调用工具";
}
