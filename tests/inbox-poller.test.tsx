// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useInboxPoller } from "../src/renderer/src/app/useInboxPoller";

const pollLeadInbox = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  pollLeadInbox.mockReset().mockResolvedValue({ hasMessages: true, count: 1 });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { pollLeadInbox },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("leaves restored inbox messages untouched until polling is enabled", async () => {
  const onInboxTurn = vi.fn();
  const { rerender } = renderHook(
    ({ enabled }) =>
      useInboxPoller({
        enabled,
        activeSessionId: "session",
        sessionLoaded: true,
        busy: false,
        onInboxTurn,
      }),
    { initialProps: { enabled: false } },
  );
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(pollLeadInbox).not.toHaveBeenCalled();
  expect(onInboxTurn).not.toHaveBeenCalled();
  await act(async () => rerender({ enabled: true }));
  expect(onInboxTurn).toHaveBeenCalledTimes(1);
});

it("does not immediately retrigger when a run changes busy back to idle", async () => {
  const onInboxTurn = vi.fn();
  const { rerender } = renderHook(
    ({ busy }) =>
      useInboxPoller({
        enabled: true,
        activeSessionId: "session",
        sessionLoaded: true,
        busy,
        onInboxTurn,
      }),
    { initialProps: { busy: false } },
  );
  await act(async () => {});
  expect(onInboxTurn).toHaveBeenCalledTimes(1);
  rerender({ busy: true });
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  rerender({ busy: false });
  await act(async () => {});
  expect(onInboxTurn).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(onInboxTurn).toHaveBeenCalledTimes(2);
});

it("ignores a poll response after switching sessions", async () => {
  let resolvePoll!: (value: { hasMessages: boolean; count: number }) => void;
  pollLeadInbox.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
  );
  const onInboxTurn = vi.fn();
  const { rerender } = renderHook(
    ({ activeSessionId, enabled }) =>
      useInboxPoller({
        enabled,
        activeSessionId,
        sessionLoaded: true,
        busy: false,
        onInboxTurn,
      }),
    { initialProps: { activeSessionId: "a", enabled: true } },
  );
  rerender({ activeSessionId: "b", enabled: false });
  await act(async () => resolvePoll({ hasMessages: true, count: 1 }));
  expect(onInboxTurn).not.toHaveBeenCalled();
});
