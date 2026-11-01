import type React from "react";
import { useMemo, useState } from "react";
import { cx } from "../lib/cx";
import type { SettingsCategory } from "../settingsCategories";
import { Input } from "./Field";
import {
  BrainIcon,
  ChartIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  FolderIcon,
  LayoutIcon,
  PaletteIcon,
  SearchIcon,
} from "./Icons";

interface SettingsSidebarProps {
  activeCategory: SettingsCategory;
  onSelectCategory: (category: SettingsCategory) => void;
  onBackToWorkspace: () => void;
}

const NAV_GROUPS: Array<{
  title: string;
  items: Array<{
    id: SettingsCategory;
    title: string;
    icon: React.ReactNode;
  }>;
}> = [
  {
    title: "工作台",
    items: [{ id: "appearance", title: "外观", icon: <PaletteIcon size={15} /> }],
  },
  {
    title: "连接",
    items: [
      { id: "models", title: "模型", icon: <BrainIcon size={15} /> },
      { id: "web-search", title: "联网搜索", icon: <SearchIcon size={15} /> },
    ],
  },
  {
    title: "演示",
    items: [{ id: "templates", title: "模板", icon: <LayoutIcon size={15} /> }],
  },
  {
    title: "Agent",
    items: [{ id: "agent", title: "Agent 行为", icon: <CheckCircleIcon size={15} /> }],
  },
  {
    title: "系统",
    items: [
      { id: "data", title: "数据与日志", icon: <FolderIcon size={15} /> },
      { id: "usage", title: "用量", icon: <ChartIcon size={15} /> },
    ],
  },
];

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
  activeCategory,
  onSelectCategory,
  onBackToWorkspace,
}) => {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();

  const visibleGroups = useMemo(() => {
    if (!query) return NAV_GROUPS;
    return NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          item.title.toLowerCase().includes(query) || group.title.toLowerCase().includes(query),
      ),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  return (
    <aside className="left-panel settings-sidebar" data-ui-region="sidebar">
      <div className="sections-container flex-1">
        <nav className="settings-nav" aria-label="设置导航">
          <Input
            type="search"
            className="settings-nav-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="筛选设置项…"
            aria-label="筛选设置项"
          />
          {visibleGroups.map((group) => (
            <div
              className="settings-nav-group"
              key={group.title}
              role="group"
              aria-label={group.title}
            >
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cx("settings-nav-item", activeCategory === item.id && "is-active")}
                  onClick={() => onSelectCategory(item.id)}
                  aria-current={activeCategory === item.id ? "page" : undefined}
                >
                  <span className="settings-nav-item-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span>{item.title}</span>
                </button>
              ))}
            </div>
          ))}
          {visibleGroups.length === 0 ? <p className="settings-hint">没有匹配的设置项</p> : null}
        </nav>
      </div>

      <div className="panel-footer left-footer settings-sidebar-footer">
        <button
          type="button"
          className="settings-nav-back"
          onClick={onBackToWorkspace}
          aria-label="返回工作区"
        >
          <ChevronRightIcon size={14} />
          <span>返回工作区</span>
        </button>
      </div>
    </aside>
  );
};
