import { randomUUID } from 'node:crypto';
import {
  type AgentProfileConfig,
  type AgentProfileVersion,
  agentProfileConfigSchema,
  agentProfileSchema,
  agentProfileVersionSchema,
  documentKindSchema,
  type WorkflowTemplateConfig,
  type WorkflowTemplateVersion,
  workflowTemplateConfigSchema,
  workflowTemplateSchema,
  workflowTemplateVersionSchema,
} from '@lingma/shared';
import { AppError } from '../errors.js';
import type { SkillService } from '../services/skills.js';
import type { WritingStore } from '../writing/store.js';
import { decode, now, type Row } from '../writing/store.js';

export class AgentLibrary {
  constructor(
    readonly store: WritingStore,
    readonly skills: SkillService,
  ) {
    this.seed();
    this.seedCreativeTemplates();
  }
  get db(): WritingStore['db'] {
    return this.store.db;
  }
  profiles() {
    return (
      this.db.prepare('SELECT id FROM agent_profiles ORDER BY updated_at DESC,id').all() as {
        id: string;
      }[]
    ).map((r) => this.profile(r.id));
  }
  profile(id: string) {
    const r = this.db.prepare('SELECT * FROM agent_profiles WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'Agent 不存在', 404);
    return agentProfileSchema.parse({
      id,
      revision: r.revision,
      archived: Boolean(r.archived),
      builtin: Boolean(r.builtin),
      draft: decode(r.draft_json),
      updatedAt: r.updated_at,
      versions: (
        this.db
          .prepare(
            'SELECT id FROM agent_profile_versions WHERE profile_id=? ORDER BY version_no DESC',
          )
          .all(id) as { id: string }[]
      ).map((v) => this.profileVersion(v.id)),
    });
  }
  profileVersion(id: string): AgentProfileVersion {
    const r = this.db.prepare('SELECT * FROM agent_profile_versions WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'Agent 发布版本不存在', 404);
    return agentProfileVersionSchema.parse({
      id,
      profileId: r.profile_id,
      versionNo: r.version_no,
      config: decode(r.config_json),
      createdAt: r.created_at,
    });
  }
  createProfile(raw: AgentProfileConfig, builtin = false) {
    const config = agentProfileConfigSchema.parse(raw);
    return this.store.database.transaction((db) => {
      const id = randomUUID();
      db.prepare(
        'INSERT INTO agent_profiles(id,revision,builtin,draft_json,updated_at) VALUES(?,1,?,?,?)',
      ).run(id, Number(builtin), JSON.stringify(config), now());
      return this.profile(id);
    });
  }
  assertRevision(actual: number, expected: number) {
    if (actual !== expected)
      throw new AppError('VERSION_CONFLICT', '配置已变化，请重新加载后合并', 409);
  }
  saveProfile(id: string, revision: number, raw: AgentProfileConfig) {
    const config = agentProfileConfigSchema.parse(raw);
    return this.store.database.transaction((db) => {
      const p = this.profile(id);
      this.assertRevision(p.revision, revision);
      db.prepare(
        'UPDATE agent_profiles SET revision=revision+1,draft_json=?,updated_at=? WHERE id=?',
      ).run(JSON.stringify(config), now(), id);
      return this.profile(id);
    });
  }
  publishProfile(id: string, revision: number) {
    return this.store.database.transaction((db) => {
      const p = this.profile(id);
      this.assertRevision(p.revision, revision);
      if (p.archived) throw new AppError('FORBIDDEN', '请先取消归档', 403);
      this.validateProfile(p.draft);
      const v = {
        id: randomUUID(),
        profileId: id,
        versionNo: (p.versions[0]?.versionNo ?? 0) + 1,
        config: p.draft,
        createdAt: now(),
      };
      db.prepare('INSERT INTO agent_profile_versions VALUES(?,?,?,?,?)').run(
        v.id,
        id,
        v.versionNo,
        JSON.stringify(v.config),
        v.createdAt,
      );
      db.prepare('UPDATE agent_profiles SET revision=revision+1,updated_at=? WHERE id=?').run(
        now(),
        id,
      );
      return this.profile(id);
    });
  }
  archive(id: string, revision: number, archived: boolean) {
    return this.store.database.transaction((db) => {
      this.assertRevision(this.profile(id).revision, revision);
      db.prepare(
        'UPDATE agent_profiles SET archived=?,revision=revision+1,updated_at=? WHERE id=?',
      ).run(Number(archived), now(), id);
      return this.profile(id);
    });
  }
  validateProfile(c: AgentProfileConfig) {
    if (
      c.providerConfigId &&
      !this.db.prepare('SELECT id FROM provider_configs WHERE id=?').get(c.providerConfigId)
    )
      throw new AppError('NOT_FOUND', '角色指定的模型配置不存在', 404);
    for (const id of c.skillVersionIds) this.skills.catalog(id);
    if (
      new Set(c.tools).size !== c.tools.length ||
      new Set(c.skillVersionIds).size !== c.skillVersionIds.length
    )
      throw new AppError('VALIDATION_ERROR', '工具及 Skill 不能重复', 400);
  }
  templates() {
    return (
      this.db
        .prepare(
          "SELECT id FROM workflow_templates ORDER BY CASE WHEN COALESCE(json_extract(draft_json,'$.taskType'),'chapter_write')='chapter_write' THEN 0 ELSE 1 END,updated_at DESC,id",
        )
        .all() as {
        id: string;
      }[]
    ).map((r) => this.template(r.id));
  }
  template(id: string) {
    const r = this.db.prepare('SELECT * FROM workflow_templates WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!r) throw new AppError('NOT_FOUND', '模板不存在', 404);
    return workflowTemplateSchema.parse({
      id,
      revision: r.revision,
      draft: decode(r.draft_json),
      updatedAt: r.updated_at,
      versions: (
        this.db
          .prepare(
            'SELECT id FROM workflow_template_versions WHERE template_id=? ORDER BY version_no DESC',
          )
          .all(id) as { id: string }[]
      ).map((v) => this.templateVersion(v.id)),
    });
  }
  templateVersion(id: string): WorkflowTemplateVersion {
    const r = this.db.prepare('SELECT * FROM workflow_template_versions WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!r) throw new AppError('NOT_FOUND', '模板发布版本不存在', 404);
    return workflowTemplateVersionSchema.parse({
      id,
      templateId: r.template_id,
      versionNo: r.version_no,
      config: decode(r.config_json),
      createdAt: r.created_at,
    });
  }
  validateTemplate(raw: WorkflowTemplateConfig, checkArchived = true) {
    const c = workflowTemplateConfigSchema.parse(raw);
    for (const s of c.steps) {
      const p = this.profileVersion(s.agentVersionId);
      const required =
        s.stage === 'revise' ? (c.taskType === 'chapter_write' ? 'draft' : 'generate') : s.stage;
      if (p.config.capability !== required)
        throw new AppError('VALIDATION_ERROR', `${s.name} 与 Agent 能力不兼容`, 400);
      if (checkArchived && this.profile(p.profileId).archived)
        throw new AppError('FORBIDDEN', `${p.config.name} 已归档，请替换`, 403);
    }
    if (
      c.steps.some((step) => step.stage === (c.taskType === 'chapter_write' ? 'generate' : 'draft'))
    )
      throw new AppError('VALIDATION_ERROR', '生成节点与模板用途不匹配', 400);
    return c;
  }
  createTemplate(raw: WorkflowTemplateConfig) {
    const c = this.validateTemplate(raw);
    return this.store.database.transaction((db) => {
      const id = randomUUID();
      db.prepare('INSERT INTO workflow_templates VALUES(?,1,?,?)').run(
        id,
        JSON.stringify(c),
        now(),
      );
      return this.template(id);
    });
  }
  saveTemplate(id: string, revision: number, raw: WorkflowTemplateConfig) {
    const c = this.validateTemplate(raw);
    return this.store.database.transaction((db) => {
      this.assertRevision(this.template(id).revision, revision);
      db.prepare(
        'UPDATE workflow_templates SET revision=revision+1,draft_json=?,updated_at=? WHERE id=?',
      ).run(JSON.stringify(c), now(), id);
      return this.template(id);
    });
  }
  publishTemplate(id: string, revision: number) {
    return this.store.database.transaction((db) => {
      const t = this.template(id);
      this.assertRevision(t.revision, revision);
      this.validateTemplate(t.draft);
      const v = {
        id: randomUUID(),
        versionNo: (t.versions[0]?.versionNo ?? 0) + 1,
        config: t.draft,
        createdAt: now(),
      };
      db.prepare('INSERT INTO workflow_template_versions VALUES(?,?,?,?,?)').run(
        v.id,
        id,
        v.versionNo,
        JSON.stringify(v.config),
        v.createdAt,
      );
      db.prepare('UPDATE workflow_templates SET revision=revision+1,updated_at=? WHERE id=?').run(
        now(),
        id,
      );
      return this.template(id);
    });
  }
  private seedCreativeTemplates() {
    this.store.database.transaction(() => {
      for (const [taskType, name, prompt] of [
        [
          'worldbuilding',
          '世界观构建与审校',
          '构建世界观条目，填写时代、地域、制度、势力、规则、代价与禁忌。只生成 worldbuilding 分类，不修改其他资料。',
        ],
        [
          'master_outline',
          '故事总纲规划',
          '规划故事起点、主线与人物弧线、关键转折、高潮和结局，提交一份完整总纲。',
        ],
        [
          'story_events',
          '故事事件规划',
          '根据授权总纲与规划范围生成有序故事事件，提供时间、摘要和完整纲要。不要生成小说正文。',
        ],
      ] as const) {
        if (
          this.db
            .prepare(
              "SELECT id FROM workflow_template_versions WHERE json_extract(config_json,'$.taskType')=? LIMIT 1",
            )
            .get(taskType)
        )
          continue;
        const generator = this.createProfile(
          agentProfileConfigSchema.parse({
            name: `${name}·生成`,
            capability: 'generate',
            prompt,
            contextKinds: documentKindSchema.options,
          }),
          true,
        );
        const author = this.publishProfile(generator.id, generator.revision).versions[0];
        const reviewer = this.createProfile(
          agentProfileConfigSchema.parse({
            name: `${name}·审校`,
            capability: 'review',
            prompt:
              '检查当前产物的规则、因果、人物目标、完整性及与授权资料的一致性。问题引用当前产物原文或字段值；P0 引用授权资料或作者要求，不编造证据。',
            contextKinds: documentKindSchema.options,
          }),
          true,
        );
        const review = this.publishProfile(reviewer.id, reviewer.revision).versions[0];
        if (!author || !review) throw new AppError('INTERNAL_ERROR', '预设角色发布失败', 500);
        const template = this.createTemplate(
          workflowTemplateConfigSchema.parse({
            taskType,
            name,
            confirmPlan: false,
            autoRevise: true,
            steps: [
              { key: 'generate', name: '生成方案', stage: 'generate', agentVersionId: author.id },
              {
                key: 'review',
                name: '一致性与完整性审校',
                stage: 'review',
                agentVersionId: review.id,
              },
              { key: 'revise', name: '定向修订', stage: 'revise', agentVersionId: author.id },
            ],
          }),
        );
        this.publishTemplate(template.id, template.revision);
      }
    });
  }
  private seed() {
    if (this.db.prepare('SELECT id FROM agent_profiles LIMIT 1').get()) return;
    this.store.database.transaction(() => {
      const definitions = [
        [
          '章纲策划',
          'plan',
          '规划本章目标、限知视角、场景推进、冲突和伏笔。未知设定列为待决事项。',
        ],
        [
          '正文作者',
          'draft',
          '按作者要求和章纲创作完整正文。修订时逐项修复问题，保留未受影响的内容。',
        ],
        [
          '一致性审校',
          'review',
          '检查人物知识边界、时间线、设定和因果。问题引用当前稿原句，硬冲突引用授权资料，不编造证据。',
        ],
        [
          '叙事审校',
          'review',
          '检查视角、人物动机、节奏、语言与章纲目标，提出具体且可执行的问题和建议。',
        ],
      ] as const;
      const versions = definitions.map(([name, capability, prompt]) => {
        const p = this.createProfile(
          agentProfileConfigSchema.parse({ name, capability, prompt }),
          true,
        );
        return this.publishProfile(p.id, p.revision).versions[0] as AgentProfileVersion;
      });
      const t = this.createTemplate(
        workflowTemplateConfigSchema.parse({
          name: '单章协作写作',
          steps: [
            { key: 'plan', name: '章纲策划', stage: 'plan', agentVersionId: versions[0]?.id },
            { key: 'draft', name: '正文初稿', stage: 'draft', agentVersionId: versions[1]?.id },
            {
              key: 'continuity',
              name: '一致性审校',
              stage: 'review',
              agentVersionId: versions[2]?.id,
            },
            {
              key: 'narrative',
              name: '叙事审校',
              stage: 'review',
              agentVersionId: versions[3]?.id,
            },
            { key: 'revise', name: '定向修订', stage: 'revise', agentVersionId: versions[1]?.id },
          ],
        }),
      );
      this.publishTemplate(t.id, t.revision);
    });
  }
}
