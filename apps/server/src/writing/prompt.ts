import {
  type AgentPrompt,
  agentPromptSchema,
  defaultAgentPrompt,
  saveAgentPromptSchema,
} from '@lingma/shared';
import type { WorkbenchDatabase } from '../db/database.js';
import { AppError } from '../errors.js';

export class AgentPromptService {
  constructor(private readonly database: WorkbenchDatabase) {}

  get(): AgentPrompt {
    const row = this.database.connection
      .prepare('SELECT prompt,revision,updated_at FROM agent_prompt_settings WHERE id=1')
      .get() as { prompt: string; revision: number; updated_at: string } | undefined;
    return agentPromptSchema.parse({
      prompt: row?.prompt ?? defaultAgentPrompt,
      defaultPrompt: defaultAgentPrompt,
      revision: row?.revision ?? 0,
      updatedAt: row?.updated_at ?? null,
    });
  }

  save(raw: unknown): AgentPrompt {
    const input = saveAgentPromptSchema.parse(raw);
    return this.database.transaction((db) => {
      const current = this.get();
      if (input.revision !== current.revision)
        throw new AppError('VERSION_CONFLICT', '提示词已在其他页面更新，请加载最新版本后合并', 409);
      if (input.prompt === current.prompt) return current;
      db.prepare(
        'INSERT INTO agent_prompt_settings(id,prompt,revision,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt,revision=excluded.revision,updated_at=excluded.updated_at',
      ).run(input.prompt, current.revision + 1, new Date().toISOString());
      return this.get();
    });
  }
}
