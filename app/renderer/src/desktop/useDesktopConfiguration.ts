import type { AgentConfigurationSnapshot } from "@agent-harness/configuration/configuration-contract";
import { useCallback, useEffect, useRef, useState } from "react";

/** 配置写入串行；卸载后的异步结果不得重新激活设置页。 */
export function useDesktopConfiguration(onChanged: () => void) {
  const [snapshot, setSnapshot] = useState<AgentConfigurationSnapshot>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const writing = useRef(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const reload = useCallback(async () => {
    if (writing.current) return;
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const saved = await window.desktopApi.getAgentConfiguration();
      if (generation.current !== request) return;
      const current = saved ?? (await window.desktopApi.initializeAgentConfiguration());
      if (generation.current === request) setSnapshot(current);
    } catch {
      if (generation.current === request) {
        setError("无法读取配置。请确认配置目录可写、系统凭据存储可用，然后重新加载。");
      }
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  const commit = async (
    operation: () => Promise<AgentConfigurationSnapshot>,
    success: string,
  ): Promise<boolean> => {
    if (writing.current || loading) return false;
    writing.current = true;
    const request = ++generation.current;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const current = await operation();
      if (generation.current !== request) return false;
      setSnapshot(current);
      setNotice(success);
      changed.current();
      return true;
    } catch {
      if (generation.current === request) {
        setError(
          "保存未完成。请检查连接配置、系统凭据存储和配置目录权限，再重试；如结果不确定，请重新加载确认。",
        );
      }
      return false;
    } finally {
      writing.current = false;
      if (generation.current === request) setPending(false);
    }
  };

  return { snapshot, loading, pending, error, notice, reload, commit };
}
