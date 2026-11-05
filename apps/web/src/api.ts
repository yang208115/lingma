import type {
  ConfirmImport,
  CreateDocument,
  ImportEncoding,
  NovelSave,
  Project,
  PutStructure,
  StartOutlineWriting,
  UpdateStoryEvent,
} from '@lingma/shared';
import {
  documentDetailSchema,
  documentVersionSchema,
  errorResponseSchema,
  importPreviewSchema,
  importResultSchema,
  pageSchema,
  projectSchema,
  responseSchema,
  structureSchema,
  versionSummarySchema,
} from '@lingma/shared';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, init);
  } catch {
    throw new ApiError('NETWORK_ERROR', '连接失败，请检查服务后重试');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      response.ok ? 'INVALID_RESPONSE' : 'HTTP_ERROR',
      `服务返回了无法解析的响应（HTTP ${response.status}），请检查服务连接后重试`,
      { status: response.status, requestId: response.headers.get('X-Request-ID') },
    );
  }
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(body);
    throw parsed.success
      ? new ApiError(parsed.data.error.code, parsed.data.error.message, parsed.data.error.details)
      : new ApiError('HTTP_ERROR', `请求失败（${response.status}）`);
  }
  return schema.parse(body);
}
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
export const api = {
  exportUrl: (projectId: string, chapterId?: string) =>
    `/api/v1/projects/${projectId}/export.txt${chapterId ? `?chapterId=${encodeURIComponent(chapterId)}` : ''}`,
  exportText: async (projectId: string, chapterId?: string) => {
    let response: Response;
    try {
      response = await fetch(api.exportUrl(projectId, chapterId));
    } catch {
      throw new ApiError('NETWORK_ERROR', '导出连接失败，请重试');
    }
    if (!response.ok)
      throw new ApiError('EXPORT_ERROR', `导出失败（${response.status}），请检查目录与文档后重试`);
    return response.blob();
  },
  projects: (cursor?: string, deleted = false) =>
    request(
      `/projects?limit=200${deleted ? '&deleted=true' : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      pageSchema(projectSchema),
    ),
  createProject: async (title: string, format: Project['format'] = 'long') =>
    (await request('/projects', responseSchema(projectSchema), json('POST', { title, format })))
      .data,
  completeProjectSetup: async (id: string, baseStructureVersion: number) =>
    (
      await request(
        `/projects/${id}/setup-completion`,
        responseSchema(projectSchema),
        json('POST', { baseStructureVersion }),
      )
    ).data,
  deleteProject: async (id: string, baseStructureVersion: number) =>
    (
      await request(
        `/projects/${id}`,
        responseSchema(projectSchema),
        json('DELETE', { baseStructureVersion }),
      )
    ).data,
  restoreProject: async (id: string) =>
    (await request(`/projects/${id}/restore`, responseSchema(projectSchema), { method: 'POST' }))
      .data,
  renameProject: async (id: string, title: string, baseStructureVersion: number) =>
    (
      await request(
        `/projects/${id}`,
        responseSchema(projectSchema),
        json('PATCH', { title, baseStructureVersion }),
      )
    ).data,
  structure: async (id: string) =>
    (await request(`/projects/${id}/structure`, responseSchema(structureSchema))).data,
  putStructure: async (id: string, input: PutStructure) =>
    (
      await request(
        `/projects/${id}/structure`,
        responseSchema(structureSchema),
        json('PUT', input),
      )
    ).data,
  createDocument: async (project: string, input: CreateDocument) =>
    (
      await request(
        `/projects/${project}/documents`,
        responseSchema(documentDetailSchema),
        json('POST', input),
      )
    ).data,
  document: async (id: string) =>
    (await request(`/documents/${id}`, responseSchema(documentDetailSchema))).data,
  startOutlineWriting: async (id: string, input: StartOutlineWriting) =>
    (
      await request(
        `/documents/${id}/start-writing`,
        responseSchema(documentDetailSchema),
        json('POST', input),
      )
    ).data,
  save: async (id: string, input: NovelSave) =>
    (await request(`/documents/${id}`, responseSchema(documentDetailSchema), json('PUT', input)))
      .data,
  updateStoryEvent: async (id: string, input: UpdateStoryEvent) =>
    (
      await request(
        `/documents/${id}/event-plan`,
        responseSchema(documentDetailSchema),
        json('PUT', input),
      )
    ).data,
  versions: (id: string, cursor?: string) =>
    request(
      `/documents/${id}/versions?limit=200${cursor ? `&cursor=${cursor}` : ''}`,
      pageSchema(versionSummarySchema),
    ),
  version: async (id: string, version: string) =>
    (await request(`/documents/${id}/versions/${version}`, responseSchema(documentVersionSchema)))
      .data,
  restore: async (id: string, baseVersionId: string, restoreVersionId: string) =>
    (
      await request(
        `/documents/${id}/restore`,
        responseSchema(documentDetailSchema),
        json('POST', { baseVersionId, restoreVersionId }),
      )
    ).data,
  deleteDocument: (id: string, baseVersionId: string, baseStructureVersion: number) =>
    request(
      `/documents/${id}`,
      { parse: (value: unknown) => value },
      json('DELETE', { baseVersionId, baseStructureVersion }),
    ),
  importFile: async (project: string, file: File, encoding: ImportEncoding) => {
    const form = new FormData();
    form.set('file', file);
    form.set('encoding', encoding);
    return (
      await request(`/projects/${project}/imports`, responseSchema(importPreviewSchema), {
        method: 'POST',
        body: form,
      })
    ).data;
  },
  importPreview: async (project: string, id: string) =>
    (await request(`/projects/${project}/imports/${id}`, responseSchema(importPreviewSchema))).data,
  confirmImport: async (project: string, id: string, input: ConfirmImport) =>
    (
      await request(
        `/projects/${project}/imports/${id}/confirm`,
        responseSchema(importResultSchema),
        json('POST', input),
      )
    ).data,
};
