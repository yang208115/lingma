import {
  type AgentProfileConfig,
  agentProfileSchema,
  agentTestResultSchema,
  responseSchema,
  type WorkflowDecision,
  type WorkflowInput,
  type WorkflowInputRequest,
  type WorkflowTemplateConfig,
  workflowPreviewSchema,
  workflowRunSchema,
  workflowTemplateSchema,
} from '@lingma/shared';
import { request } from './api.js';

const json = (body: unknown, method = 'POST', key: string = crypto.randomUUID()): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
  body: JSON.stringify(body),
});
export const workflowApi = {
  refreshSources: async (id: string, expectedRevision: number, content?: string) =>
    (
      await request(
        `/workflows/${id}/refresh-sources`,
        responseSchema(workflowRunSchema),
        json({ expectedRevision, content }),
      )
    ).data,
  testProfile: async (id: string, expectedRevision: number, input: WorkflowInputRequest) =>
    (
      await request(
        `/agent-profiles/${id}/test-runs`,
        responseSchema(agentTestResultSchema),
        json({ expectedRevision, input }),
      )
    ).data,
  testResult: async (id: string) =>
    (await request(`/agent-test-runs/${id}`, responseSchema(agentTestResultSchema))).data,
  profiles: async () =>
    (await request('/agent-profiles', responseSchema(agentProfileSchema.array()))).data,
  createProfile: async (config: AgentProfileConfig) =>
    (await request('/agent-profiles', responseSchema(agentProfileSchema), json(config))).data,
  saveProfile: async (id: string, expectedRevision: number, config: AgentProfileConfig) =>
    (
      await request(
        `/agent-profiles/${id}/draft`,
        responseSchema(agentProfileSchema),
        json({ expectedRevision, config }, 'PATCH'),
      )
    ).data,
  publishProfile: async (id: string, expectedRevision: number) =>
    (
      await request(
        `/agent-profiles/${id}/versions`,
        responseSchema(agentProfileSchema),
        json({ expectedRevision }),
      )
    ).data,
  archiveProfile: async (id: string, expectedRevision: number, archived: boolean) =>
    (
      await request(
        `/agent-profiles/${id}/archive`,
        responseSchema(agentProfileSchema),
        json({ expectedRevision, archived }),
      )
    ).data,
  templates: async () =>
    (await request('/workflow-templates', responseSchema(workflowTemplateSchema.array()))).data,
  createTemplate: async (config: WorkflowTemplateConfig) =>
    (await request('/workflow-templates', responseSchema(workflowTemplateSchema), json(config)))
      .data,
  saveTemplate: async (id: string, expectedRevision: number, config: WorkflowTemplateConfig) =>
    (
      await request(
        `/workflow-templates/${id}/draft`,
        responseSchema(workflowTemplateSchema),
        json({ expectedRevision, config }, 'PATCH'),
      )
    ).data,
  publishTemplate: async (id: string, expectedRevision: number) =>
    (
      await request(
        `/workflow-templates/${id}/versions`,
        responseSchema(workflowTemplateSchema),
        json({ expectedRevision }),
      )
    ).data,
  preview: async (input: WorkflowInputRequest) =>
    (await request('/workflow-previews', responseSchema(workflowPreviewSchema), json(input))).data,
  create: async (input: WorkflowInput, key: string) =>
    (await request('/workflows', responseSchema(workflowRunSchema), json(input, 'POST', key))).data,
  runs: async (projectId: string, sessionId?: string) =>
    (
      await request(
        `/workflows?${new URLSearchParams({ projectId, ...(sessionId ? { sessionId } : {}) })}`,
        responseSchema(workflowRunSchema.array()),
      )
    ).data,
  run: async (id: string) =>
    (await request(`/workflows/${id}`, responseSchema(workflowRunSchema))).data,
  decide: async (id: string, decision: WorkflowDecision, key: string) =>
    (
      await request(
        `/workflows/${id}/decisions`,
        responseSchema(workflowRunSchema),
        json(decision, 'POST', key),
      )
    ).data,
};
