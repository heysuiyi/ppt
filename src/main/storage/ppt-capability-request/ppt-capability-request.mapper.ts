import type { DatabaseSync } from "node:sqlite";
import {
  type PptCapabilityRequest,
  type PptJobId,
  pptCapabilityRequestSchema,
} from "@shared/presentation-lifecycle";
import type { PptCapabilityRequestDO } from "./ppt-capability-request.do";

export class PptCapabilityRequestMapper {
  constructor(private readonly database: DatabaseSync) {}

  findById(requestId: PptCapabilityRequest["requestId"]): PptCapabilityRequest | undefined {
    const row = this.database
      .prepare("SELECT request_json FROM ppt_capability_requests WHERE request_id = ?")
      .get(requestId) as Pick<PptCapabilityRequestDO, "request_json"> | undefined;
    return row ? pptCapabilityRequestSchema.parse(JSON.parse(row.request_json)) : undefined;
  }

  findByQuery(
    jobId: PptJobId,
    queryId: PptCapabilityRequest["queryId"] & string,
  ): PptCapabilityRequest | undefined {
    const row = this.database
      .prepare(`
      SELECT request_json FROM ppt_capability_requests
      WHERE job_id = ? AND query_id = ?
    `)
      .get(jobId, queryId) as Pick<PptCapabilityRequestDO, "request_json"> | undefined;
    return row ? pptCapabilityRequestSchema.parse(JSON.parse(row.request_json)) : undefined;
  }

  insert(request: PptCapabilityRequest): void {
    this.database
      .prepare(`
      INSERT INTO ppt_capability_requests(
        request_id, job_id, query_id, capability, request_json, requested_at
      ) VALUES(?, ?, ?, ?, ?, ?)
    `)
      .run(
        request.requestId,
        request.jobId,
        request.queryId ?? null,
        request.capability,
        JSON.stringify(request),
        request.requestedAt,
      );
  }
}
