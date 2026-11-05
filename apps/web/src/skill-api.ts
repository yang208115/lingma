import {
  type GitImport,
  pageSchema,
  responseSchema,
  type SkillImportJob,
  type SkillListFilter,
  skillDetailSchema,
  skillImportJobSchema,
  skillJobsSchema,
  skillSchema,
  skillVersionSummarySchema,
} from '@lingma/shared';
import { ApiError, request } from './api.js';
import { splitSkillDirectory } from './skill-import.js';

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
function filterQuery(filter: SkillListFilter = {}) {
  const params = new URLSearchParams();
  if (filter.scope) params.set('scope', filter.scope);
  if (filter.projectId) params.set('projectId', filter.projectId);
  return params.toString();
}
export const skillApi = {
  list: (cursor?: string, filter: SkillListFilter = {}) =>
    request(
      `/skills?limit=200&${filterQuery(filter)}${cursor ? `&cursor=${cursor}` : ''}`,
      pageSchema(skillSchema),
    ),
  detail: async (id: string, versionId?: string) =>
    (
      await request(
        `/skills/${id}${versionId ? `/versions/${versionId}` : ''}`,
        responseSchema(skillDetailSchema),
      )
    ).data,
  versions: (id: string, cursor?: string) =>
    request(
      `/skills/${id}/versions?limit=200${cursor ? `&cursor=${cursor}` : ''}`,
      pageSchema(skillVersionSummarySchema),
    ),
  save: async (id: string, baseVersionId: string, entryContent: string) =>
    (
      await request(`/skills/${id}`, responseSchema(skillDetailSchema), {
        ...json({ baseVersionId, entryContent }),
        method: 'PUT',
      })
    ).data,
  jobs: async (filter: SkillListFilter = {}) =>
    (await request(`/skill-imports?${filterQuery(filter)}`, responseSchema(skillJobsSchema))).data,
  job: async (id: string) =>
    (await request(`/skill-imports/${id}`, responseSchema(skillImportJobSchema))).data,
  git: async (input: GitImport, projectId: string | null = null) =>
    (
      await request(
        '/skills/import/git',
        responseSchema(skillImportJobSchema),
        json({ ...input, projectId }),
      )
    ).data,
  changeScope: async (id: string, baseVersionId: string, projectId: string | null) =>
    (
      await request(`/skills/${id}/scope`, responseSchema(skillDetailSchema), {
        ...json({ baseVersionId, projectId }),
        method: 'PATCH',
      })
    ).data,
  update: async (id: string, baseVersionId: string) =>
    (
      await request(
        `/skills/${id}/update-source`,
        responseSchema(skillImportJobSchema),
        json({ baseVersionId }),
      )
    ).data,
  local: async (
    files: File[],
    target?: { skillId: string; baseVersionId: string },
    paths = files.map((file) => file.webkitRelativePath || file.name),
    projectId: string | null = null,
  ) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    form.set('paths', JSON.stringify(paths));
    if (projectId) form.set('projectId', projectId);
    if (target) {
      form.set('skillId', target.skillId);
      form.set('baseVersionId', target.baseVersionId);
    }
    return (
      await request('/skills/import/local', responseSchema(skillImportJobSchema), {
        method: 'POST',
        body: form,
      })
    ).data;
  },
  localDirectory: async (
    files: File[],
    onJob: (job: SkillImportJob) => void,
    projectId: string | null = null,
  ) => {
    const { skills, ignored } = splitSkillDirectory(
      files.map((file) => file.webkitRelativePath || file.name),
    );
    const jobs: SkillImportJob[] = [];
    const failures: { directory: string; message: string }[] = [];
    for (const group of skills) {
      try {
        const deadline = Date.now() + 120_000;
        const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 500));
        let job: SkillImportJob;
        while (true) {
          try {
            job = await skillApi.local(
              group.indices.map((index) => files[index] as File),
              undefined,
              group.paths,
              projectId,
            );
            break;
          } catch (error) {
            // Only an explicit busy rejection proves that no import was created.
            if (
              !(error instanceof ApiError) ||
              error.code !== 'PROJECT_BUSY' ||
              Date.now() >= deadline
            )
              throw error;
            await pause();
          }
        }
        onJob(job);
        while (['queued', 'fetching', 'publishing'].includes(job.status)) {
          if (Date.now() >= deadline) throw new Error('等待导入完成超时，请在导入记录中查看该任务');
          await pause();
          try {
            job = await skillApi.job(job.id);
          } catch (error) {
            if (
              error instanceof ApiError &&
              (['NETWORK_ERROR', 'INVALID_RESPONSE'].includes(error.code) ||
                (error.code === 'HTTP_ERROR' && Number(error.details.status) >= 500))
            )
              continue;
            throw error;
          }
          onJob(job);
        }
        jobs.push(job);
        if (job.status !== 'completed') throw new Error(job.error ?? '导入未完成，请查看导入记录');
      } catch (error) {
        failures.push({
          directory: group.root || '所选目录',
          message: error instanceof Error ? error.message : '上传失败',
        });
      }
    }
    return { jobs, failures, ignored };
  },
  fileUrl: (id: string, versionId: string, path: string) =>
    `/api/v1/skills/${id}/versions/${versionId}/file?path=${encodeURIComponent(path)}`,
  file: async (id: string, versionId: string, path: string) => {
    const response = await fetch(skillApi.fileUrl(id, versionId, path));
    if (!response.ok) throw new ApiError('FILE_ERROR', `附件读取失败（${response.status}）`);
    return new Uint8Array(await response.arrayBuffer());
  },
};
