import { describe, expect, it } from "vitest";
import { expectedExportSvgHashSource, liftSvgText } from "../src/ppt/core/svg-text-lift";

describe("liftSvgText", () => {
  it("lifts a simple left-aligned text node and strips it from the background", () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<rect width="1280" height="720" fill="#0f172a"/>' +
      '<text x="80" y="180" font-size="64" fill="#ffffff">Opportunity</text>' +
      "</svg>";

    const result = liftSvgText(markup);

    expect(result.texts).toHaveLength(1);
    expect(result.texts[0]).toMatchObject({
      content: "Opportunity",
      color: "FFFFFF",
      align: "left",
      bold: false,
      fontFace: "Arial",
    });
    expect(result.texts[0].fontSizePt).toBeCloseTo(64 * 0.5625, 5);
    expect(result.texts[0].xIn).toBeCloseTo(80 * (10 / 1280), 5);
    expect(result.backgroundSvg).not.toContain("<text");
    expect(result.backgroundSvg).toContain("<rect");
    expect(expectedExportSvgHashSource(markup)).toBe(result.backgroundSvg);
  });

  it("centers a middle-anchored title", () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<text x="640" y="360" fill="#f8fafc" font-size="64" text-anchor="middle"' +
      ' font-family="Arial, sans-serif">Agent PPT</text>' +
      "</svg>";

    const result = liftSvgText(markup);
    expect(result.texts).toHaveLength(1);
    expect(result.texts[0].align).toBe("center");
    expect(result.texts[0].fontFace).toBe("Arial");
    // Box should start left of the anchor.
    expect(result.texts[0].xIn).toBeLessThan(640 * (10 / 1280));
    expect(result.texts[0].xIn + result.texts[0].wIn / 2).toBeCloseTo(640 * (10 / 1280), 1);
  });

  it("joins tspan lines when dy separates them", () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<text x="40" y="80" font-size="32" fill="#111827">' +
      '<tspan x="40" dy="0">Line one</tspan>' +
      '<tspan x="40" dy="40">Line two</tspan>' +
      "</text></svg>";

    const result = liftSvgText(markup);
    expect(result.texts).toHaveLength(1);
    expect(result.texts[0].content).toBe("Line one\nLine two");
  });

  it("skips text inside defs and leaves it in the background", () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<defs><text x="10" y="20" font-size="12">Hidden</text></defs>' +
      '<text x="80" y="140" font-size="48" fill="#000">Visible</text>' +
      "</svg>";

    const result = liftSvgText(markup);
    expect(result.texts).toHaveLength(1);
    expect(result.texts[0].content).toBe("Visible");
    expect(result.backgroundSvg).toContain(">Hidden</text>");
    expect(result.backgroundSvg).not.toContain(">Visible</text>");
  });

  it("does not lift transformed or textPath nodes", () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<text x="80" y="80" font-size="32" transform="rotate(15)">Rotated</text>' +
      '<text x="80" y="200" font-size="32"><textPath href="#p">Path</textPath></text>' +
      "</svg>";

    const result = liftSvgText(markup);
    expect(result.texts).toHaveLength(0);
    expect(result.backgroundSvg).toBe(markup);
    expect(expectedExportSvgHashSource(markup)).toBe(markup);
  });

  it("sizes full-width CJK lines by their real advance width", () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<text x="72" y="120" font-size="34" font-weight="700" fill="#f8fafc">' +
      '<tspan x="72" dy="0">决策仍在「周」的节奏，</tspan>' +
      '<tspan x="72" dy="46">业务已在「小时」的战场</tspan>' +
      "</text></svg>";

    const result = liftSvgText(markup);
    expect(result.texts).toHaveLength(1);
    const [title] = result.texts;
    // 11 full-width glyphs at 34px need ~2.9in; a narrower box would reflow in PowerPoint.
    expect(title.wIn).toBeGreaterThan(2.9);
    expect(title.lineSpacingPt).toBeCloseTo(46 * 0.5625, 3);
    expect(title.charSpacingPt).toBe(0);
  });

  it("accounts for letter-spacing when sizing a Latin line", () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<text x="88" y="60" font-size="12" letter-spacing="2.5" fill="#7dd3fc">THE GAP</text>' +
      "</svg>";

    const result = liftSvgText(markup);
    const [label] = result.texts;
    expect(label.charSpacingPt).toBeCloseTo(2.5 * 0.5625, 3);
    expect(label.wIn).toBeGreaterThan(0.45);
  });

  it("returns the original markup when there is no text", () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<rect width="1280" height="720" fill="#fff"/></svg>';
    const result = liftSvgText(markup);
    expect(result.texts).toEqual([]);
    expect(result.backgroundSvg).toBe(markup);
  });

  it("marks bold weights and decodes entities", () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<text x="40" y="80" font-size="24" font-weight="700" fill="#abc">A &amp; B</text>' +
      "</svg>";
    const result = liftSvgText(markup);
    expect(result.texts[0].bold).toBe(true);
    expect(result.texts[0].content).toBe("A & B");
    expect(result.texts[0].color).toBe("AABBCC");
  });
});
