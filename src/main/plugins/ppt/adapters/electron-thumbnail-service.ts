import type { DesignSystemV2 } from "@design-system";
import type { Slide } from "@shared/presentation";
import {
  exportSlideThumbnailHtml,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
} from "@shared/slide-html-render";
import { BrowserWindow } from "electron";

export interface SlideThumbnailResult {
  pngBase64: string;
  width: number;
  height: number;
  mimeType: "image/png";
}

function isElectronRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.electron;
}

/**
 * Renders a slide to PNG via hidden BrowserWindow + capturePage.
 * Returns null outside Electron (e.g. vitest).
 */
export class SlideThumbnailService {
  private captureWindow: BrowserWindow | null = null;
  private captureQueue: Promise<void> = Promise.resolve();

  captureSlide(slide: Slide, designSystem: DesignSystemV2): Promise<SlideThumbnailResult | null> {
    if (!isElectronRuntime()) return Promise.resolve(null);
    const capture = this.captureQueue.then(() => this.captureSlideSerially(slide, designSystem));
    this.captureQueue = capture.then(
      () => undefined,
      () => undefined,
    );
    return capture;
  }

  private async captureSlideSerially(
    slide: Slide,
    designSystem: DesignSystemV2,
  ): Promise<SlideThumbnailResult> {
    const html = exportSlideThumbnailHtml(slide, { designSystem });
    const window = await this.ensureWindow();

    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await this.waitForRender(window);

    const image = await window.webContents.capturePage({
      x: 0,
      y: 0,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
    });

    const resized = image.resize({
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      quality: "best",
    });

    return {
      pngBase64: resized.toPNG().toString("base64"),
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      mimeType: "image/png",
    };
  }

  dispose(): void {
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      this.captureWindow.destroy();
    }
    this.captureWindow = null;
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      return this.captureWindow;
    }

    this.captureWindow = new BrowserWindow({
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      show: false,
      frame: false,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        sandbox: true,
      },
    });

    return this.captureWindow;
  }

  private async waitForRender(window: BrowserWindow): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const renderReady = window.webContents.executeJavaScript(
      `
      (async () => {
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
        }
        const images = Array.from(document.images);
        await Promise.all(images.map(async (image) => {
          if (typeof image.decode === "function") {
            await image.decode();
            return;
          }
          if (!image.complete || image.naturalWidth === 0) {
            throw new Error("A slide image failed to load.");
          }
        }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return true;
      })()
    `,
      true,
    );
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Thumbnail render did not settle within 5 seconds.")),
        5_000,
      );
    });
    try {
      await Promise.race([renderReady, timedOut]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export const slideThumbnailService = new SlideThumbnailService();
