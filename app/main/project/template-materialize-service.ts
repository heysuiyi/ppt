import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { SessionSnapshot } from "@shared/session";
import { buildTemplatePack } from "@shared/template-projection";
import {
  APPLICATION_DEFAULT_TEMPLATE_ID,
  formatProjectTemplatePolicy,
  formatTemplatePack,
  projectTemplatePolicySchema,
  TEMPLATE_PACK_PATH,
  TEMPLATE_POLICY_PATH,
  type TemplatePack,
  type TemplatePackAsset,
  templateAssetDirectory,
} from "@shared/template-protocol";
import JSZip from "jszip";
import type { ProjectFileService } from "./project-file-service";
import {
  applicationTemplateLibrary,
  copyTemplateRevision,
  listTemplateDescriptors,
  projectTemplateLibrary,
  readTemplateRevision,
} from "./template-import-service";

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function extractAssetsIntoProject(input: {
  projectRootPath: string;
  packageAbsolutePath: string;
  revisionId: string;
  mediaCandidates: Array<{ entry: string; roleHint?: string }>;
}): Promise<TemplatePackAsset[]> {
  const bytes = await readFile(input.packageAbsolutePath);
  const zip = await JSZip.loadAsync(bytes);
  const relativeDir = templateAssetDirectory(input.revisionId);
  const absoluteDir = join(input.projectRootPath, relativeDir);
  await mkdir(absoluteDir, { recursive: true });

  const assets: TemplatePackAsset[] = [];
  const candidates = input.mediaCandidates.slice(0, 12);
  let logoCount = 0;
  let decorationCount = 0;

  for (const candidate of candidates) {
    const entry = zip.file(candidate.entry);
    if (!entry || entry.dir) continue;
    const mediaBytes = Buffer.from(await entry.async("nodebuffer"));
    if (mediaBytes.byteLength <= 0) continue;

    const extension = extname(candidate.entry).toLowerCase() || ".bin";
    if (![".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".emf", ".wmf"].includes(extension)) {
      continue;
    }
    // Skip EMF/WMF for SVG embedding — not usable as <image href> in product path.
    if (extension === ".emf" || extension === ".wmf") continue;

    const role =
      candidate.roleHint === "background"
        ? ("background" as const)
        : candidate.roleHint === "logo" && logoCount === 0
          ? ("logo" as const)
          : ("decoration" as const);
    if (role === "logo") logoCount += 1;
    if (role === "decoration") {
      decorationCount += 1;
      if (decorationCount > 4) continue;
    }

    const safeBase = basename(candidate.entry)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(0, 80);
    const fileName = `${role}-${assets.length + 1}-${safeBase}`;
    const relativePath = `${relativeDir}/${fileName}`;
    await writeFile(join(input.projectRootPath, relativePath), mediaBytes);
    assets.push({
      role,
      path: relativePath,
      contentHash: hashBytes(mediaBytes),
      originalEntry: candidate.entry,
    });
  }

  // Attach logo path onto chrome later via pack builder / caller.
  return assets;
}

function buildDesignSpecSeed(pack: TemplatePack): string {
  const ds = pack.designSystem;
  const seed = {
    version: 1,
    canvas: { width: 1280, height: 720 },
    communicationContract: {
      audience: "（待根据用户需求填写）",
      objective: "（待根据用户需求填写）",
      desiredOutcome: "（待根据用户需求填写）",
      coreMessage: "（待根据用户需求填写）",
      deliveryContext: "（待根据用户需求填写）",
      afterUse: "（待根据用户需求填写）",
    },
    presentationDesignSystem: ds,
    argumentMode: ds.argumentMode,
    visualStyle: { id: ds.visualStyle },
    readingMode: ds.readingMode,
    resolvedTemplate: {
      templateId: pack.templateId,
      templateRevisionId: pack.revisionId,
      source: "explicit-custom",
      reasons: [`Seeded from template pack ${pack.templateId}@${pack.revisionId}`],
      supportLevel: "design-reference",
    },
    typography: pack.typography,
    colors: typeof ds.colorScheme === "string" ? { named: ds.colorScheme } : ds.colorScheme,
    templateChrome: pack.chrome,
    templateAssets: pack.assets,
    forbidden: pack.authoringGuidance.avoid,
  };
  return `${JSON.stringify(seed, null, 2)}\n`;
}

export interface MaterializeCustomTemplateInput {
  snapshot: SessionSnapshot;
  projectFileService: ProjectFileService;
  templateId: string;
  revisionId: string;
  /** Preserve an existing project defaultTemplateId when set. */
  defaultTemplateId?: string;
}

/**
 * Unified apply/seed path: copy revision → extract assets → write pack +
 * policy=custom → seed/patch design-spec axes so new chats cannot silently
 * fall back to builtin styling.
 */
export async function materializeCustomTemplate(
  input: MaterializeCustomTemplateInput,
): Promise<TemplatePack> {
  const rootPath = input.snapshot.project?.rootPath;
  if (!rootPath) {
    throw new Error("Session has no project sandbox for template binding.");
  }

  const projectLibrary = projectTemplateLibrary(rootPath);
  const alreadyLocal = (await listTemplateDescriptors(projectLibrary)).some(
    (item) => item.id === input.templateId && item.revisionId === input.revisionId,
  );
  if (!alreadyLocal) {
    await copyTemplateRevision({
      from: applicationTemplateLibrary(),
      to: projectLibrary,
      templateId: input.templateId,
      revisionId: input.revisionId,
    });
  }

  const { descriptor, inspection, absoluteRoot } = await readTemplateRevision(
    projectLibrary,
    input.templateId,
    input.revisionId,
  );
  const packageKind = descriptor.source?.packageKind ?? inspection.packageKind;
  const packageAbsolutePath = join(absoluteRoot, `source.${packageKind}`);
  const assets = await extractAssetsIntoProject({
    projectRootPath: rootPath,
    packageAbsolutePath,
    revisionId: descriptor.revisionId,
    mediaCandidates: inspection.mediaCandidates ?? [],
  });

  // Bind first logo into header chrome when present.
  const logo = assets.find((asset) => asset.role === "logo");
  const inspectionWithLogo =
    logo && inspection.chrome
      ? {
          ...inspection,
          chrome: {
            ...inspection.chrome,
            header: inspection.chrome.header
              ? { ...inspection.chrome.header, logoAsset: logo.path }
              : {
                  y: 24,
                  height: 40,
                  align: "left" as const,
                  logoAsset: logo.path,
                },
          },
        }
      : inspection;

  const pack = buildTemplatePack({
    descriptor,
    inspection: inspectionWithLogo,
    assets,
  });

  await input.projectFileService.writeArtifact(
    input.snapshot,
    TEMPLATE_PACK_PATH,
    formatTemplatePack(pack),
    { overwrite: true },
  );

  const policy = projectTemplatePolicySchema.parse({
    version: 1,
    mode: "custom",
    defaultTemplateId: input.defaultTemplateId ?? APPLICATION_DEFAULT_TEMPLATE_ID,
    customTemplateId: pack.templateId,
    customTemplateRevisionId: pack.revisionId,
  });
  await input.projectFileService.writeArtifact(
    input.snapshot,
    TEMPLATE_POLICY_PATH,
    formatProjectTemplatePolicy(policy),
    { overwrite: true },
  );

  // Seed design-spec when missing or when resolvedTemplate contradicts the pack.
  // Never overwrite a real user communicationContract that already matches the pack.
  let shouldWriteSeed = true;
  try {
    const existing = await input.projectFileService.readArtifact(
      input.snapshot,
      "design/design-spec.json",
    );
    if (typeof existing.content === "string") {
      const parsed = JSON.parse(existing.content) as {
        resolvedTemplate?: { templateId?: string; templateRevisionId?: string };
        communicationContract?: { audience?: string };
      };
      const matches =
        parsed.resolvedTemplate?.templateId === pack.templateId &&
        parsed.resolvedTemplate?.templateRevisionId === pack.revisionId;
      const audience = parsed.communicationContract?.audience ?? "";
      const hasRealContract = audience.length > 0 && !audience.includes("待根据用户需求");
      shouldWriteSeed = !(matches && hasRealContract);
    }
  } catch {
    shouldWriteSeed = true;
  }

  if (shouldWriteSeed) {
    await input.projectFileService.writeArtifact(
      input.snapshot,
      "design/design-spec.json",
      buildDesignSpecSeed(pack),
      { overwrite: true },
    );
  }

  return pack;
}
