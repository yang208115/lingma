import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { type ModelAdapter, PiModelAdapter } from '@lingma/agent';
import { type ProviderInput, providerInputSchema, providerSchema } from '@lingma/shared';
import type { WorkbenchDatabase } from '../db/database.js';
import { AppError } from '../errors.js';
import { LocalCredentials } from './credentials.js';

export class ProviderService {
  private readonly credentials: LocalCredentials;
  constructor(
    readonly database: WorkbenchDatabase,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    this.credentials = new LocalCredentials(dirname(database.connection.name));
  }
  credential(reference: string): string {
    if (reference.startsWith('local:')) {
      const value = this.credentials.get(reference);
      if (!value) throw new AppError('PROVIDER_AUTH_ERROR', '请重新填写 API 密钥', 400);
      return value;
    }
    if (!/^env:[A-Z][A-Z0-9_]{1,100}$/.test(reference))
      throw new AppError('PROVIDER_AUTH_ERROR', '凭据引用无效', 400);
    const value = this.env[reference.slice(4)];
    if (!value?.trim()) throw new AppError('PROVIDER_AUTH_ERROR', '服务端环境凭据未配置', 400);
    return value;
  }
  adapter(): ModelAdapter {
    return new PiModelAdapter({
      resolveCredential: (ref) => this.credential(ref),
      fetch: this.fetcher,
    });
  }
  get(id: string) {
    const row = this.database.connection
      .prepare('SELECT * FROM provider_configs WHERE id=?')
      .get(id) as
      | { id: string; revision: number; config_json: string; updated_at: string }
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', '模型配置不存在', 404);
    const config = providerInputSchema.parse(JSON.parse(row.config_json));
    let configured =
      config.connection.credentialRef === null &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.connection.baseUrl).hostname);
    if (config.connection.credentialRef) {
      try {
        this.credential(config.connection.credentialRef);
        configured = true;
      } catch {
        configured = false;
      }
    }
    return providerSchema.parse({
      id,
      revision: row.revision,
      config,
      credentialConfigured: configured,
      updatedAt: row.updated_at,
    });
  }
  list() {
    return (
      this.database.connection
        .prepare('SELECT id FROM provider_configs ORDER BY updated_at,id')
        .all() as { id: string }[]
    ).map((row) => this.get(row.id));
  }
  save(raw: ProviderInput, id: string = randomUUID(), revision?: number, apiKey?: string) {
    const input = providerInputSchema.parse(raw);
    const reference = apiKey ? `local:${randomUUID()}` : undefined;
    if (reference) input.connection.credentialRef = reference;
    const url = new URL(input.connection.baseUrl);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new AppError('VALIDATION_ERROR', '远程模型接口必须使用 HTTPS', 400);
    this.database.transaction((db) => {
      const exists = db.prepare('SELECT revision FROM provider_configs WHERE id=?').get(id) as
        | { revision: number }
        | undefined;
      if (exists && exists.revision !== revision)
        throw new AppError('VERSION_CONFLICT', '模型配置已变化，请刷新', 409);
      if (!exists && revision !== undefined) throw new AppError('NOT_FOUND', '模型配置不存在', 404);
      if (!exists && this.list().length >= 50)
        throw new AppError('VALIDATION_ERROR', '最多保存 50 个模型配置', 400);
      if (reference && apiKey) this.credentials.set(reference, apiKey);
      db.prepare(
        'INSERT INTO provider_configs(id,revision,config_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,updated_at=excluded.updated_at',
      ).run(id, (exists?.revision ?? 0) + 1, JSON.stringify(input), new Date().toISOString());
    });
    return this.get(id);
  }
}
