import {
  type ActionArgs,
  type ActionName,
  type ActionOutcome,
  type ActionResult,
  actionNameSchema,
  actionSchemas,
  actionToolDefinition,
  type Json,
  type ModelCall,
} from '@lingma/shared';
import { ActionError, AgentError } from '../errors.js';
import { json } from '../json.js';

export interface ActionContext {
  runId: string;
  turnIndex: number;
  executionId: string;
  signal: AbortSignal;
}
export type ActionHandlers = {
  [N in ActionName]?: (
    args: ActionArgs<N>,
    context: ActionContext,
  ) => ActionResult<N> | Promise<ActionResult<N>>;
};
export class ActionRegistry {
  private readonly handlers: Readonly<ActionHandlers>;
  readonly names: readonly ActionName[];
  constructor(
    handlers: ActionHandlers,
    private readonly options: {
      onInvalidArguments?: (call: ModelCall, context: ActionContext) => void;
    } = {},
  ) {
    for (const key of Object.keys(handlers))
      if (!actionNameSchema.safeParse(key).success) throw new AgentError('VALIDATION_ERROR');
    this.handlers = Object.freeze({ ...handlers });
    this.names = Object.freeze(
      actionNameSchema.options.filter((name) => typeof handlers[name] === 'function'),
    );
  }
  definitions(): Json[] {
    return this.names.map((name) => json(actionToolDefinition(name)));
  }
  async execute(call: ModelCall, context: ActionContext): Promise<ActionOutcome> {
    const fail = (
      code: 'UNKNOWN_TOOL' | 'FORBIDDEN' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR',
      message: string,
    ): ActionOutcome => ({ callId: call.id, ok: false, error: { code, message } });
    const name = actionNameSchema.safeParse(call.name);
    if (!name.success) return fail('UNKNOWN_TOOL', '未知动作，请使用本次提供的动作定义');
    const handler = this.handlers[name.data];
    if (!handler) return fail('FORBIDDEN', '本次运行未授权此动作');
    try {
      context.signal.throwIfAborted();
      const parsed = actionSchemas[name.data].args.safeParse(call.arguments);
      if (!parsed.success) {
        this.options.onInvalidArguments?.(call, context);
        const issues = parsed.error.issues.map((issue) => {
          const path = issue.path.map(String).join('.') || '参数';
          if (issue.code === 'unrecognized_keys')
            return `${path}：请移除未定义字段 ${issue.keys.join('、')}。`;
          return `${path}：${issue.message}`;
        });
        const hint =
          name.data === 'propose_document_change'
            ? '只提交 content（完整替换文本）、reason（修改理由）、citations（真实引用 ID 数组，无引用传 []）；目标、版本和范围已由服务端绑定。'
            : '请修正上述字段后重试。';
        return fail(
          'VALIDATION_ERROR',
          `参数校验失败：${issues.join('；')} ${hint}`.slice(0, 4000),
        );
      }
      // The name/schema pair is selected together from the fixed registry; no model-supplied code runs.
      const value = await (
        handler as (args: typeof parsed.data, context: ActionContext) => unknown
      )(parsed.data, context);
      const checked = actionSchemas[name.data].result.safeParse(value);
      if (!checked.success) throw new AgentError('INTERNAL_ERROR');
      const outcome: ActionOutcome = { callId: call.id, ok: true, value: json(checked.data) };
      return outcome;
    } catch (error) {
      if (error instanceof AgentError && ['STORAGE_ERROR', 'INTERNAL_ERROR'].includes(error.code))
        throw error;
      if (context.signal.aborted) throw error;
      if (error instanceof AgentError) {
        return {
          callId: call.id,
          ok: false,
          error: {
            code: error.code,
            ...(error instanceof ActionError && error.publicDetails !== undefined
              ? { details: error.publicDetails }
              : {}),
            message:
              error instanceof ActionError
                ? error.publicMessage.slice(0, 4000)
                : '动作未能完成，请检查授权、目标与版本后修正请求',
          },
        };
      }
      throw new AgentError('INTERNAL_ERROR');
    }
  }
}
