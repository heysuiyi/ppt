import { z } from "zod";

export const levelSchema = z.enum(["low", "medium", "high", "unknown"]);

export const operationSchema = z.enum([
  "answer",
  "content",
  "create",
  "edit",
  "restyle",
  "review",
  "export",
]);

export const deliverableSchema = z.enum([
  "answer",
  "content",
  "deck",
  "review-report",
  "pptx",
]);

export const collabPreferenceSchema = z.enum([
  "required",
  "allowed",
  "forbidden",
  "unspecified",
]);

export const difficultyDimsSchema = z
  .object({
    workload: levelSchema,
    factBurden: levelSchema,
    visual: levelSchema,
    coupling: levelSchema,
    uncertainty: levelSchema,
  })
  .strict();

export const openQuestionSchema = z
  .object({
    question: z.string().min(1),
    resolveBy: z.enum(["read", "tool", "user"]).default("user"),
  })
  .strict();

export const taskAssessmentSchema = z
  .object({
    operation: operationSchema,
    deliverable: deliverableSchema,
    dims: difficultyDimsSchema,
    collab: collabPreferenceSchema.default("unspecified"),
    wantsFix: z.boolean().optional(),
    wantsExport: z.boolean().optional(),
    wantsRedesign: z.boolean().optional(),
    openQuestions: z.array(openQuestionSchema).default([]),
  })
  .strict();

export const setPptTaskAssessmentSchema = z
  .object({
    assessment: taskAssessmentSchema,
    selectedCandidateId: z.string().min(1).nullish(),
    selectionReason: z.string().max(2_000).optional(),
  })
  .strict();
