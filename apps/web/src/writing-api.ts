import {
  agentPromptSchema,
  chatMessageSchema,
  connectionCheckSchema,
  contextPreviewSchema,
  outlineCreationProposalSchema,
  type ProviderInput,
  pageSchema,
  proposalAcceptSchema,
  proposalSchema,
  providerSchema,
  responseSchema,
  runDetailSchema,
  runSummarySchema,
  sessionSchema,
  sessionHistorySchema,
  type WritingRunInput,
} from '@lingma/shared';
import { request } from './api.js';

const json = (body: unknown, key?: string, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
});
export const writingApi = {
  agentPrompt: async () => (await request('/agent-prompt', responseSchema(agentPromptSchema))).data,
  saveAgentPrompt: async (prompt: string, revision: number) =>
    (
      await request(
        '/agent-prompt',
        responseSchema(agentPromptSchema),
        json({ prompt, revision }, undefined, 'PUT'),
      )
    ).data,
  providers: () => request('/provider-configs', pageSchema(providerSchema)),
  saveProvider: async (config: ProviderInput, id?: string, revision?: number, apiKey?: string) =>
    (
      await request(
        id ? `/provider-configs/${id}` : '/provider-configs',
        responseSchema(providerSchema),
        json(
          id
            ? { config, revision, ...(apiKey ? { apiKey } : {}) }
            : { ...config, ...(apiKey ? { apiKey } : {}) },
          undefined,
          id ? 'PUT' : 'POST',
        ),
      )
    ).data,
  check: async (id: string) =>
    (
      await request(`/provider-configs/${id}/check`, responseSchema(connectionCheckSchema), {
        method: 'POST',
      })
    ).data,
  preview: async (input: WritingRunInput) =>
    (await request('/context/preview', responseSchema(contextPreviewSchema), json(input))).data,
  create: async (input: WritingRunInput, key: string) =>
    (await request('/runs', responseSchema(runSummarySchema), json(input, key))).data,
  runs: (project: string, session?: string, cursor?: string) =>
    request(
      `/runs?projectId=${project}&limit=50${session ? `&sessionId=${session}` : ''}${cursor ? `&cursor=${cursor}` : ''}`,
      pageSchema(runSummarySchema),
    ),
  run: async (id: string) => (await request(`/runs/${id}`, responseSchema(runDetailSchema))).data,
  cancel: async (id: string) =>
    (await request(`/runs/${id}/cancel`, responseSchema(runSummarySchema), { method: 'POST' }))
      .data,
  retry: async (id: string, key: string) =>
    (await request(`/runs/${id}/retry`, responseSchema(runSummarySchema), json({}, key))).data,
  accept: async (id: string, key: string) =>
    (await request(`/proposals/${id}/accept`, responseSchema(proposalAcceptSchema), json({}, key)))
      .data,
  reject: async (id: string) =>
    (await request(`/proposals/${id}/reject`, responseSchema(proposalSchema), { method: 'POST' }))
      .data,
  acceptOutlineCreation: async (id: string, key: string) =>
    (
      await request(
        `/outline-proposals/${id}/accept`,
        responseSchema(outlineCreationProposalSchema),
        json({}, key),
      )
    ).data,
  rejectOutlineCreation: async (id: string) =>
    (
      await request(
        `/outline-proposals/${id}/reject`,
        responseSchema(outlineCreationProposalSchema),
        json({}),
      )
    ).data,
  sessions: (project: string, cursor?: string, query = '', deleted = false) =>
    request(
      `/projects/${project}/sessions?${new URLSearchParams({ ...(cursor ? { cursor } : {}), q: query, deleted: deleted ? '1' : '0' })}`,
      pageSchema(sessionHistorySchema),
    ),
  getSession: async (id: string) =>
    (await request(`/sessions/${id}`, responseSchema(sessionHistorySchema))).data,
  renameSession: async (id: string, title: string) =>
    (
      await request(
        `/sessions/${id}`,
        responseSchema(sessionHistorySchema),
        json({ title }, undefined, 'PATCH'),
      )
    ).data,
  deleteSession: async (id: string) =>
    (await request(`/sessions/${id}`, responseSchema(sessionHistorySchema), { method: 'DELETE' }))
      .data,
  restoreSession: async (id: string) =>
    (await request(`/sessions/${id}/restore`, responseSchema(sessionHistorySchema), json({}))).data,
  session: async (project: string, title: string, chapterId: string | null) =>
    (
      await request(
        `/projects/${project}/sessions`,
        responseSchema(sessionSchema),
        json({ title, chapterId }),
      )
    ).data,
  messages: (session: string, cursor?: string) =>
    request(
      `/sessions/${session}/messages${cursor ? `?cursor=${cursor}` : ''}`,
      pageSchema(chatMessageSchema),
    ),
};
export async function textHash(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
