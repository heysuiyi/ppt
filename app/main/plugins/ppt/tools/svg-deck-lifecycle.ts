import { hashArtifactValue } from "@ppt/core/artifact-hash";
import type {
  ArtifactDependency,
  ArtifactPointer,
  BlobReference,
  PptJobProjection,
  ValidationReport,
} from "@shared/presentation-lifecycle";
import { blobReferenceSchema } from "@shared/presentation-lifecycle";
import type { PptLifecycleToolBridge } from "../../../agent/tools/tool-definition";
import type { HydratedSvgPage } from "../svg-page-loader";
import { normalizeWorkspaceSvgPath } from "../svg-page-loader";
import {
  assertSvgPageBelongsToPlan,
  readSvgDeckLocks,
  type SvgDeckDesignSpec,
  type SvgDeckPagePlan,
} from "./svg-deck-locks";

const SVG_AUTHORING_CAPABILITIES = ["create", "edit", "restyle"] as const;
const SVG_PREVIEW_CAPABILITIES = [...SVG_AUTHORING_CAPABILITIES, "review"] as const;

interface SvgLifecycleValues {
  designSpec: SvgDeckDesignSpec;
  pagePlan: SvgDeckPagePlan;
  page: ReturnType<typeof pageArtifactValue>;
  assets: ReturnType<typeof sourceAssetValue>[];
}

export async function commitSvgPagePreviewLifecycle(input: {
  lifecycle: PptLifecycleToolBridge;
  fileService: Parameters<typeof readSvgDeckLocks>[0];
  page: HydratedSvgPage;
}): Promise<void> {
  input.lifecycle.requireActiveCapability(SVG_PREVIEW_CAPABILITIES);
  const locks = await readSvgDeckLocks(input.fileService, "PreviewSvgPage");
  assertSvgPageBelongsToPlan(input.page.sourcePath, locks.pagePlan);
  const values = await storeLifecycleValues(input.lifecycle, input.page, locks);

  input.lifecycle.withTransaction(() => {
    const designSpec = ensureArtifact(input.lifecycle, {
      artifactId: "design-spec",
      kind: "design_spec",
      stage: "design_spec",
      value: values.designSpec,
      dependencies: [],
      validator: "svg-deck-design-spec",
    });
    const pagePlan = ensureArtifact(input.lifecycle, {
      artifactId: "page-plan",
      kind: "page_plan",
      stage: "page_plan",
      value: values.pagePlan,
      dependencies: [dependency(designSpec)],
      validator: "svg-deck-page-plan",
    });
    const assets = values.assets.map((asset) =>
      ensureArtifact(input.lifecycle, {
        artifactId: sourceAssetArtifactId(asset.sourcePath),
        kind: "source_asset",
        stage: "page_svg",
        value: asset,
        dependencies: [],
        validator: "svg-page-source-asset",
      }),
    );
    const page = ensureArtifact(input.lifecycle, {
      artifactId: pageArtifactId(input.page.sourcePath),
      kind: "page_svg",
      stage: "page_svg",
      value: values.page,
      dependencies: [dependency(designSpec), dependency(pagePlan), ...assets.map(dependency)],
      validator: "svg-page",
    });
    ensureArtifact(input.lifecycle, {
      artifactId: previewReceiptArtifactId(input.page.sourcePath),
      kind: "preview_receipt",
      stage: "preview",
      value: previewReceiptValue(input.page, page),
      dependencies: [dependency(page)],
      validator: "svg-page-rendered-preview",
    });
  });
}

export async function assertSvgPageLifecycleCurrent(input: {
  lifecycle: PptLifecycleToolBridge;
  fileService: Parameters<typeof readSvgDeckLocks>[0];
  page: HydratedSvgPage;
  locks?: {
    designSpec: SvgDeckDesignSpec;
    pagePlan: SvgDeckPagePlan;
  };
}): Promise<void> {
  input.lifecycle.requireActiveCapability(SVG_AUTHORING_CAPABILITIES);
  const locks = input.locks ?? (await readSvgDeckLocks(input.fileService));
  assertSvgPageBelongsToPlan(input.page.sourcePath, locks.pagePlan);
  const values = currentLifecycleValues(input.page, locks);
  const projection = input.lifecycle.requireActiveCapability(SVG_AUTHORING_CAPABILITIES);

  requireCurrentArtifact(projection, "design-spec", values.designSpec);
  requireCurrentArtifact(projection, "page-plan", values.pagePlan);
  for (const asset of values.assets) {
    requireCurrentArtifact(projection, sourceAssetArtifactId(asset.sourcePath), asset);
  }
  const page = requireCurrentArtifact(
    projection,
    pageArtifactId(input.page.sourcePath),
    values.page,
  );
  const receiptValue = previewReceiptValue(input.page, page);
  requireCurrentArtifact(projection, previewReceiptArtifactId(input.page.sourcePath), receiptValue);
  await assertLifecycleBlobs(input.lifecycle, values);

  // The lock revisions are intentionally checked above even though the
  // receipt depends transitively on them. This produces a precise lock-file
  // error when an external edit is observed before submit.
}

function lifecycleValues(
  page: HydratedSvgPage,
  locks: {
    designSpec: SvgDeckDesignSpec;
    pagePlan: SvgDeckPagePlan;
  },
  pageBlob: BlobReference,
  assetBlobs: ReadonlyMap<string, BlobReference>,
): SvgLifecycleValues {
  return {
    ...locks,
    page: pageArtifactValue(page, pageBlob),
    assets: page.resources.map((resource) => {
      const blob = assetBlobs.get(resource.sha256);
      if (!blob) {
        throw new Error(`Hydrated SVG resource bytes are missing for ${resource.sourcePath}.`);
      }
      return sourceAssetValue(resource, blob);
    }),
  };
}

async function storeLifecycleValues(
  lifecycle: PptLifecycleToolBridge,
  page: HydratedSvgPage,
  locks: {
    designSpec: SvgDeckDesignSpec;
    pagePlan: SvgDeckPagePlan;
  },
): Promise<SvgLifecycleValues> {
  const pageBlob = await lifecycle.storeBlob(Buffer.from(page.markup, "utf8"), "image/svg+xml");
  assertExpectedBlob(
    pageBlob,
    blobReference(page.sha256, "image/svg+xml", page.byteSize),
    page.sourcePath,
  );
  const assetBlobs = new Map<string, BlobReference>();
  for (const content of page.resourceContents) {
    const blob = await lifecycle.storeBlob(content.bytes, content.resource.mimeType);
    assertExpectedBlob(
      blob,
      blobReference(content.resource.sha256, content.resource.mimeType, content.resource.byteSize),
      content.resource.sourcePath,
    );
    assetBlobs.set(content.resource.sha256, blob);
  }
  return lifecycleValues(page, locks, pageBlob, assetBlobs);
}

function currentLifecycleValues(
  page: HydratedSvgPage,
  locks: {
    designSpec: SvgDeckDesignSpec;
    pagePlan: SvgDeckPagePlan;
  },
): SvgLifecycleValues {
  return lifecycleValues(
    page,
    locks,
    blobReference(page.sha256, "image/svg+xml", page.byteSize),
    new Map(
      page.resources.map((resource) => [
        resource.sha256,
        blobReference(resource.sha256, resource.mimeType, resource.byteSize),
      ]),
    ),
  );
}

async function assertLifecycleBlobs(
  lifecycle: PptLifecycleToolBridge,
  values: SvgLifecycleValues,
): Promise<void> {
  const blobs = [
    { sourcePath: values.page.sourcePath, blob: values.page.blob },
    ...values.assets.map((asset) => ({
      sourcePath: asset.sourcePath,
      blob: asset.blob,
    })),
  ];
  for (const entry of blobs) {
    try {
      await lifecycle.assertBlob(entry.blob);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `SVG lifecycle blob is missing or invalid for ${entry.sourcePath}: ${detail}. ` +
          "Call PreviewSvgPage with includeThumbnail=true for the current page.",
      );
    }
  }
}

function pageArtifactValue(page: HydratedSvgPage, blob: BlobReference) {
  return {
    sourcePath: page.sourcePath,
    sha256: page.sha256,
    width: 1280 as const,
    height: 720 as const,
    byteSize: page.byteSize,
    resources: page.resources,
    blob,
  };
}

function sourceAssetValue(resource: HydratedSvgPage["resources"][number], blob: BlobReference) {
  return {
    sourcePath: resource.sourcePath,
    sha256: resource.sha256,
    mediaType: resource.mimeType,
    byteSize: resource.byteSize,
    blob,
  };
}

function blobReference(sha256: string, mediaType: string, byteLength: number): BlobReference {
  return blobReferenceSchema.parse({
    contentHash: `sha256:${sha256}`,
    mediaType,
    byteLength,
  });
}

function assertExpectedBlob(
  actual: BlobReference,
  expected: BlobReference,
  sourcePath: string,
): void {
  if (
    actual.contentHash !== expected.contentHash ||
    actual.mediaType !== expected.mediaType ||
    actual.byteLength !== expected.byteLength
  ) {
    throw new Error(`Blob store returned inconsistent metadata for ${sourcePath}.`);
  }
}

function previewReceiptValue(page: HydratedSvgPage, pagePointer: ArtifactPointer) {
  return {
    sourcePath: page.sourcePath,
    sha256: page.sha256,
    pageArtifactRevisionId: pagePointer.revisionId,
    pageArtifactContentHash: pagePointer.contentHash,
  };
}

function ensureArtifact(
  lifecycle: PptLifecycleToolBridge,
  input: {
    artifactId: string;
    kind: Parameters<PptLifecycleToolBridge["commitArtifact"]>[0]["kind"];
    stage: Parameters<PptLifecycleToolBridge["commitArtifact"]>[0]["stage"];
    value: unknown;
    dependencies: ArtifactDependency[];
    validator: string;
  },
): ArtifactPointer {
  const projection = lifecycle.requireActiveCapability(SVG_PREVIEW_CAPABILITIES);
  const expectedHash = hashArtifactValue(input.value);
  const current = currentArtifact(projection, input.artifactId);
  if (current?.contentHash === expectedHash && !isStale(projection, current)) {
    return current;
  }
  const dependencyKey = input.dependencies.map((item) => item.revisionId).join(",");
  return lifecycle.commitArtifact({
    artifactId: input.artifactId,
    kind: input.kind,
    stage: input.stage,
    value: input.value,
    dependencies: input.dependencies,
    validation: passedValidation(input.validator),
    idempotencyKey:
      `svg-authoring:${projection.requestId}:${input.artifactId}:` +
      `${current?.revisionId ?? "no-head"}:${expectedHash}:${dependencyKey}`,
  });
}

function requireCurrentArtifact(
  projection: PptJobProjection,
  artifactId: string,
  value: unknown,
): ArtifactPointer {
  const current = currentArtifact(projection, artifactId);
  const expectedHash = hashArtifactValue(value);
  if (!current || current.contentHash !== expectedHash || isStale(projection, current)) {
    throw new Error(
      `SVG lifecycle artifact ${artifactId} is missing or stale. ` +
        "Call PreviewSvgPage with includeThumbnail=true for the current page and locks.",
    );
  }
  return current;
}

function currentArtifact(
  projection: PptJobProjection,
  artifactId: string,
): ArtifactPointer | undefined {
  return projection.committedArtifacts.find((pointer) => pointer.artifactId === artifactId);
}

function isStale(projection: PptJobProjection, pointer: ArtifactPointer): boolean {
  return projection.staleArtifacts.some((stale) => stale.revisionId === pointer.revisionId);
}

function dependency(pointer: ArtifactPointer): ArtifactDependency {
  return {
    artifactId: pointer.artifactId,
    revisionId: pointer.revisionId,
    contentHash: pointer.contentHash,
  };
}

function pageArtifactId(sourcePath: string): string {
  return `page-svg:${normalizeWorkspaceSvgPath(sourcePath)}`;
}

function previewReceiptArtifactId(sourcePath: string): string {
  return `preview-receipt:${normalizeWorkspaceSvgPath(sourcePath)}`;
}

function sourceAssetArtifactId(sourcePath: string): string {
  return `source-asset:${sourcePath}`;
}

function passedValidation(validator: string): ValidationReport {
  return {
    status: "passed",
    validator,
    issues: [],
    validatedAt: new Date().toISOString(),
  };
}
