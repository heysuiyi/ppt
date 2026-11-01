import { type RefObject, useLayoutEffect } from "react";

interface AnchoredPositionOptions {
  triggerRef: RefObject<HTMLElement | null>;
  popupRef: RefObject<HTMLElement | null>;
  open: boolean;
  align: "start" | "end";
  minWidth: number;
  onAnchorHidden: () => void;
}

/** DOMRect 使用视口坐标；top-layer 的 fixed 样式仍受所属 DOM 的 CSS zoom 影响。 */
function effectiveZoom(element: HTMLElement): number {
  let zoom = 1;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const value = getComputedStyle(ancestor).zoom;
    const factor = Number.parseFloat(value);
    if (Number.isFinite(factor) && factor > 0) {
      zoom *= value.endsWith("%") ? factor / 100 : factor;
    }
  }
  return zoom;
}

/** 只负责本次弹层的几何与监听，不拥有打开状态或跨组件注册。 */
export function useAnchoredPosition({
  triggerRef,
  popupRef,
  open,
  align,
  minWidth,
  onAnchorHidden,
}: AnchoredPositionOptions) {
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!open || !trigger || !popup) return;

    let frame = 0;
    let active = true;
    const update = () => {
      frame = 0;
      if (!active) return;
      const bounds = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      if (
        !trigger.isConnected ||
        !trigger.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
        trigger.closest("[hidden], [inert]") ||
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        bounds.bottom <= viewportTop ||
        bounds.top >= viewportTop + viewportHeight ||
        bounds.right <= viewportLeft ||
        bounds.left >= viewportLeft + viewportWidth
      ) {
        onAnchorHidden();
        return;
      }

      const zoom = effectiveZoom(popup);
      const boundary = 16;
      const gap = 4 * zoom;
      const availableWidth = Math.max(0, viewportWidth - boundary * 2);
      popup.style.maxWidth = `${availableWidth / zoom}px`;
      popup.style.minWidth = `${Math.min(bounds.width, availableWidth) / zoom}px`;
      popup.style.width = `${Math.min(Math.max(bounds.width, minWidth * zoom), availableWidth) / zoom}px`;
      const popupStyle = getComputedStyle(popup);
      const borders =
        Number.parseFloat(popupStyle.borderTopWidth) +
        Number.parseFloat(popupStyle.borderBottomWidth);
      const desiredHeight = Math.min(popup.scrollHeight + borders, 320) * zoom;
      const below = Math.max(0, viewportTop + viewportHeight - boundary - bounds.bottom - gap);
      const above = Math.max(0, bounds.top - viewportTop - boundary - gap);
      const placeBelow = desiredHeight <= below || below >= above;
      popup.style.maxHeight = `${Math.min(320, (placeBelow ? below : above) / zoom)}px`;
      const popupBounds = popup.getBoundingClientRect();
      const left = align === "end" ? bounds.right - popupBounds.width : bounds.left;
      const top = placeBelow ? bounds.bottom + gap : bounds.top - gap - popupBounds.height;
      // 所有翻转、夹取先在同一视口空间计算，最后仅换算一次，避免 zoom: 2 重复放大。
      popup.style.left = `${
        Math.max(
          viewportLeft + boundary,
          Math.min(left, viewportLeft + viewportWidth - boundary - popupBounds.width),
        ) / zoom
      }px`;
      popup.style.top = `${
        Math.max(
          viewportTop + boundary,
          Math.min(top, viewportTop + viewportHeight - boundary - popupBounds.height),
        ) / zoom
      }px`;
      popup.dataset.positioned = "true";
    };
    const schedule = () => {
      if (active && !frame) frame = requestAnimationFrame(update);
    };

    update();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(trigger);
    resizeObserver.observe(popup);
    // hidden 页面保留挂载；监听所属祖先即可，不扫描文档内其他 UI 实例。
    const visibilityObserver = new MutationObserver(schedule);
    for (let ancestor: HTMLElement | null = trigger; ancestor; ancestor = ancestor.parentElement) {
      visibilityObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: ["hidden", "inert", "class", "style", "open"],
      });
    }
    const intersectionObserver = new IntersectionObserver((entries) => {
      if (!active) return;
      if (entries.some((entry) => !entry.isIntersecting)) onAnchorHidden();
      else schedule();
    });
    intersectionObserver.observe(trigger);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);

    return () => {
      active = false;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      delete popup.dataset.positioned;
    };
  }, [triggerRef, popupRef, open, align, minWidth, onAnchorHidden]);
}
