import {
  type ElementCandidate,
  type ElementData,
  type ElementGenerationInput,
  type ElementKind,
  elementCandidatePayloadSchema,
  elementCandidateSchema,
  elementEntriesSchema,
  elementEntrySchema,
  elementGenerationPreviewSchema,
  elementGenerationSchema,
  elementGenerationsSchema,
  responseSchema,
} from '@lingma/shared';
import { request } from './api.js';

const json = (body: unknown, key?: string, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
});
export const candidatePayload = (candidate: ElementCandidate) =>
  elementCandidatePayloadSchema.parse(
    Object.fromEntries(
      Object.keys(elementCandidatePayloadSchema.shape).map((key) => [
        key,
        candidate[key as keyof ElementCandidate],
      ]),
    ),
  );
export const elementApi = {
  entry: async (id: string) =>
    (await request(`/elements/${id}`, responseSchema(elementEntrySchema))).data,
  list: async (project: string) =>
    (await request(`/projects/${project}/elements`, responseSchema(elementEntriesSchema))).data,
  create: async (
    project: string,
    kind: ElementKind,
    title: string,
    content: string,
    data: ElementData,
  ) =>
    (
      await request(
        `/projects/${project}/elements`,
        responseSchema(elementEntrySchema),
        json({ kind, title, content, data }),
      )
    ).data,
  save: async (
    id: string,
    baseVersionId: string,
    title: string,
    content: string,
    data: ElementData,
  ) =>
    (
      await request(
        `/elements/${id}`,
        responseSchema(elementEntrySchema),
        json({ baseVersionId, title, content, data }, undefined, 'PUT'),
      )
    ).data,
  confirm: async (id: string, baseVersionId: string) =>
    (
      await request(
        `/documents/${id}/element-confirmations`,
        responseSchema(elementEntrySchema),
        json({ baseVersionId }),
      )
    ).data,
  preview: async (project: string, input: ElementGenerationInput) =>
    (
      await request(
        `/projects/${project}/element-generation-previews`,
        responseSchema(elementGenerationPreviewSchema),
        json(input),
      )
    ).data,
  start: async (project: string, input: ElementGenerationInput, key: string) =>
    (
      await request(
        `/projects/${project}/element-generations`,
        responseSchema(elementGenerationSchema),
        json(input, key),
      )
    ).data,
  jobs: async (project: string) =>
    (
      await request(
        `/projects/${project}/element-generations`,
        responseSchema(elementGenerationsSchema),
      )
    ).data,
  job: async (id: string) =>
    (await request(`/element-generations/${id}`, responseSchema(elementGenerationSchema))).data,
  cancel: async (id: string) =>
    (
      await request(`/element-generations/${id}/cancel`, responseSchema(elementGenerationSchema), {
        method: 'POST',
      })
    ).data,
  retry: async (id: string, key: string) =>
    (
      await request(
        `/element-generations/${id}/retry`,
        responseSchema(elementGenerationSchema),
        json({}, key),
      )
    ).data,
  regenerate: async (candidate: ElementCandidate, key: string) =>
    (
      await request(
        `/element-candidates/${candidate.id}/regenerate`,
        responseSchema(elementGenerationSchema),
        json({ revision: candidate.revision }, key),
      )
    ).data,
  edit: async (
    candidate: ElementCandidate,
    value: { title: string; content: string; data: ElementData },
  ) =>
    (
      await request(
        `/element-candidates/${candidate.id}`,
        responseSchema(elementCandidateSchema),
        json(
          { revision: candidate.revision, payload: { ...candidatePayload(candidate), ...value } },
          undefined,
          'PATCH',
        ),
      )
    ).data,
  decide: async (
    id: string,
    action: 'accept' | 'reject',
    candidates: ElementCandidate[],
    key: string,
  ) =>
    (
      await request(
        `/element-generations/${id}/decisions`,
        responseSchema(elementGenerationSchema),
        json(
          { action, candidates: candidates.map((c) => ({ id: c.id, revision: c.revision })) },
          key,
        ),
      )
    ).data,
};
