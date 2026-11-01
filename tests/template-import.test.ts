import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "@main/session-store";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  applicationTemplateLibrary,
  copyTemplateRevision,
  importTemplatePackage,
  listTemplateDescriptors,
  projectTemplateLibrary,
} from "../app/main/project/template-import-service";

async function createMinimalPptx(filePath: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldSz cx="9144000" cy="5143500"/>
</p:presentation>`,
  );
  zip.file(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements>
    <a:clrScheme name="Test">
      <a:dk1><a:srgbClr val="111111"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F2937"/></a:dk2>
      <a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>
      <a:accent1><a:srgbClr val="2563EB"/></a:accent1>
      <a:accent2><a:srgbClr val="F59E0B"/></a:accent2>
      <a:accent3><a:srgbClr val="10B981"/></a:accent3>
      <a:accent4><a:srgbClr val="EF4444"/></a:accent4>
      <a:accent5><a:srgbClr val="8B5CF6"/></a:accent5>
      <a:accent6><a:srgbClr val="06B6D4"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink>
      <a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Test">
      <a:majorFont><a:latin typeface="Inter"/></a:majorFont>
      <a:minorFont><a:latin typeface="Source Sans 3"/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`,
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld name="Title Slide">
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="914400"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Footer"/><p:nvPr><p:ph type="ftr"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="4800600"/><a:ext cx="4572000" cy="274320"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:t>Brand Footer</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree/></p:cSld>
</p:sld>`,
  );
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(filePath, bytes);
}

describe("template import service", () => {
  it("imports a pptx as design-reference and reuses the same hash", async () => {
    const root = join(tmpdir(), `ppt-template-import-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const source = join(root, "brand.pptx");
    await createMinimalPptx(source);

    const first = await importTemplatePackage({
      library: projectTemplateLibrary(root),
      sourceFilePath: source,
      displayName: "Brand Deck",
    });
    expect(first.descriptor.supportLevel).toBe("design-reference");
    expect(first.descriptor.kind).toBe("uploaded");
    expect(first.reusedExisting).toBe(false);
    expect(first.inspection.supportLevel).toBe("design-reference");
    expect(first.inspection.chrome?.titleFrame).toBeTruthy();
    expect(first.inspection.chrome?.footer?.text).toContain("Brand Footer");
    expect(first.descriptor.designSystem.colorScheme).toMatchObject({
      name: "imported-reference",
      primary: "#2563eb",
    });

    const second = await importTemplatePackage({
      library: projectTemplateLibrary(root),
      sourceFilePath: source,
    });
    expect(second.reusedExisting).toBe(true);
    expect(second.descriptor.id).toBe(first.descriptor.id);
    expect(second.descriptor.revisionId).toBe(first.descriptor.revisionId);
  });

  it("keeps the application library reusable across separate projects", async () => {
    const root = join(tmpdir(), `ppt-template-library-${randomUUID()}`);
    const applicationRoot = join(root, "app-data");
    const projectRoot = join(root, "project");
    await mkdir(root, { recursive: true });
    const source = join(root, "brand.pptx");
    await createMinimalPptx(source);

    const library = applicationTemplateLibrary(applicationRoot);
    const imported = await importTemplatePackage({
      library,
      sourceFilePath: source,
      displayName: "Shared Brand",
    });
    expect(await listTemplateDescriptors(library)).toHaveLength(1);

    const projectLibrary = projectTemplateLibrary(projectRoot);
    const copied = await copyTemplateRevision({
      from: library,
      to: projectLibrary,
      templateId: imported.descriptor.id,
      revisionId: imported.descriptor.revisionId,
    });
    expect(copied.id).toBe(imported.descriptor.id);
    expect(copied.revisionId).toBe(imported.descriptor.revisionId);
    expect(copied.source?.sourcePath).toBe(
      `design/templates/${copied.id.replace(/[^a-zA-Z0-9._-]+/g, "-")}` +
        `/${copied.revisionId}/source.pptx`,
    );

    const reCopied = await copyTemplateRevision({
      from: library,
      to: projectLibrary,
      templateId: imported.descriptor.id,
      revisionId: imported.descriptor.revisionId,
    });
    expect(reCopied.revisionId).toBe(copied.revisionId);
    expect(await listTemplateDescriptors(projectLibrary)).toHaveLength(1);
  });
});

describe("imported templates across sessions", () => {
  const stores: FileSessionStore[] = [];
  const directories: string[] = [];
  const previousDataRoot = process.env.AGENT_PPT_DATA_DIR;

  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
    process.env.AGENT_PPT_DATA_DIR = previousDataRoot;
  });

  async function createStore(): Promise<FileSessionStore> {
    const directory = join(tmpdir(), `ppt-template-sessions-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    directories.push(directory);
    process.env.AGENT_PPT_DATA_DIR = directory;
    const store = new FileSessionStore(
      join(directory, "conversations.sqlite"),
      join(directory, "projects"),
    );
    stores.push(store);
    await store.initialize();
    return store;
  }

  it("survives new sessions and can be applied or pinned as the new project default", async () => {
    const store = await createStore();
    const source = join(directories[0], "brand.pptx");
    await createMinimalPptx(source);

    const first = await store.createSession({ title: "First" });
    const firstSessionId = first.activeSession!.session.id;
    const imported = await store.importProjectTemplate(firstSessionId, source, "Brand Deck");
    expect(
      (await store.listProjectTemplates(firstSessionId)).some(
        (item) => item.id === imported.templateId,
      ),
    ).toBe(true);
    const firstPack = await store.getProjectTemplatePack(firstSessionId);
    expect(firstPack?.templateId).toBe(imported.templateId);
    expect(firstPack?.inheritance.titleFrame).toBe(true);
    expect(firstPack?.inheritance.headerFooter).toBe(true);

    const second = await store.createSession({ title: "Second" });
    const secondSessionId = second.activeSession!.session.id;
    expect((await store.listApplicationTemplates()).map((item) => item.id)).toContain(
      imported.templateId,
    );
    expect((await store.getProjectTemplatePolicy(secondSessionId)).mode).toBe("auto");
    expect(await store.getProjectTemplatePack(secondSessionId)).toBeNull();

    await store.applyTemplateToProject(secondSessionId, imported.templateId, imported.revisionId);
    const appliedPolicy = await store.getProjectTemplatePolicy(secondSessionId);
    expect(appliedPolicy.mode).toBe("custom");
    expect(appliedPolicy.customTemplateId).toBe(imported.templateId);
    const appliedPack = await store.getProjectTemplatePack(secondSessionId);
    expect(appliedPack?.name).toBe("Brand Deck");
    expect(appliedPack?.designSystem.colorScheme).toMatchObject({
      name: "imported-reference",
    });
    expect(
      (await store.listProjectTemplates(secondSessionId)).some(
        (item) => item.id === imported.templateId,
      ),
    ).toBe(true);

    const third = await store.createSession({
      title: "Third",
      defaultTemplateId: imported.templateId,
    });
    const thirdSessionId = third.activeSession!.session.id;
    const seededPolicy = await store.getProjectTemplatePolicy(thirdSessionId);
    expect(seededPolicy.mode).toBe("custom");
    expect(seededPolicy.customTemplateId).toBe(imported.templateId);
    expect(seededPolicy.customTemplateRevisionId).toBe(imported.revisionId);
    const seededPack = await store.getProjectTemplatePack(thirdSessionId);
    expect(seededPack?.templateId).toBe(imported.templateId);
    expect(seededPack?.revisionId).toBe(imported.revisionId);
    expect(
      (await store.listProjectTemplates(thirdSessionId)).some(
        (item) => item.id === imported.templateId,
      ),
    ).toBe(true);
  });
});
