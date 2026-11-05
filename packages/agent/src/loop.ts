import {
  type ActionOutcome,
  actionSchemas,
  idSchema,
  type LoopCheckpoint,
  modelEventSchema,
  type RunEvent,
  runEventSchema,
  usageSchema,
} from '@lingma/shared';
import { abortable, RunControl } from './control.js';
import { AgentError, LoopStop } from './errors.js';
import { canonical } from './json.js';
import type { LoopInput, LoopRecord, LoopResult } from './loop-types.js';
import {
  publicRequest,
  validateCheckpoint,
  validateNewCalls,
  validateResponse,
} from './protocol.js';
import { UsageAccumulator } from './usage.js';

type EventPayload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, 'schemaVersion' | 'runId' | 'seq'>
    : never
  : never;
export async function runLoop(input: LoopInput): Promise<LoopResult> {
  // Configuration errors occur before any provider request or recording starts.
  idSchema.parse(input.runId);
  const request = publicRequest({
    ...structuredClone(input.request),
    toolDefinitions: input.registry.definitions(),
  });
  if (
    input.request.toolDefinitions.length &&
    canonical(input.request.toolDefinitions) !== canonical(request.toolDefinitions)
  )
    throw new AgentError('VALIDATION_ERROR');
  input.adapter.validateRequest?.(structuredClone(request));
  if (!Number.isSafeInteger(input.initialSeq ?? 0) || (input.initialSeq ?? 0) < 0)
    throw new AgentError('VALIDATION_ERROR');
  const initial = input.checkpoint
    ? validateCheckpoint(input.checkpoint, request, input.adapter.id)
    : null;
  const clock = input.clock ?? { now: () => performance.now(), wallNow: () => Date.now() };
  const control = new RunControl(input.signal);
  const usage = new UsageAccumulator();
  let seq = input.initialSeq ?? 0;
  let checkpoint: LoopCheckpoint | null = initial;
  let messages = structuredClone(initial?.messages ?? request.messages);
  let turns = 0;
  let attemptedTurns = 0;
  let output: LoopResult['output'] = null;
  let stopReason: LoopResult['stopReason'] = 'INTERNAL_ERROR';
  let recordingFailed = false;
  const event = (payload: EventPayload): RunEvent =>
    runEventSchema.parse({ schemaVersion: 1, runId: input.runId, seq: ++seq, ...payload });
  const record = async (entry: LoopRecord) => {
    try {
      await input.recorder.record(structuredClone(entry));
    } catch {
      recordingFailed = true;
      throw new AgentError('STORAGE_ERROR');
    }
  };
  const emit = async (payload: EventPayload) => record({ kind: 'event', event: event(payload) });
  try {
    await emit({
      type: 'run.started',
      modelId: request.modelId,
      startedAt: new Date(clock.wallNow()).toISOString(),
    });
    control.check();
    if (initial?.lastTurn.response.stop === 'complete') {
      output = {
        messageId: initial.lastTurn.messageId,
        text: initial.lastTurn.response.text,
        committed: true,
      };
      stopReason = 'complete';
    } else
      for (let index = 0; ; index++) {
        control.check();
        const turnIndex = (initial?.nextTurnIndex ?? 0) + index;
        const nextRequest = { ...structuredClone(request), messages: structuredClone(messages) };
        const messageId = crypto.randomUUID();
        let response: ReturnType<typeof validateResponse> | undefined;
        control.check();
        await record({ kind: 'request', turnIndex, messageId, request: nextRequest });
        await emit({ type: 'turn.started', turnIndex });
        control.check();
        const callUsage = usage.begin();
        attemptedTurns++;
        output = { messageId, text: '', committed: false };
        const callControl = control.modelCall();
        let iterator: AsyncIterator<import('./model/types.js').ModelEvent> | undefined;
        try {
          iterator = input.adapter
            .stream(structuredClone(nextRequest), callControl.signal)
            [Symbol.asyncIterator]();
          while (true) {
            callControl.check();
            const item = await abortable(iterator.next(), callControl.signal);
            callControl.check();
            if (item.done) break;
            // Retain valid usage even if another part of the final envelope is malformed.
            if (item.value?.type === 'response') {
              const known = usageSchema.safeParse(item.value.response?.usage);
              if (known.success && !response) usage.set(callUsage, known.data);
            }
            const parsed = modelEventSchema.safeParse(item.value);
            if (!parsed.success || response) throw new AgentError('MODEL_PROTOCOL_ERROR');
            const value = parsed.data;
            if (value.type === 'text_delta') {
              const text = value.text;
              output.text += text;
              if (text) {
                await record({
                  kind: 'model_event',
                  turnIndex,
                  event: { type: 'text_delta', text },
                });
                await emit({ type: 'text.delta', turnIndex, messageId, text });
              }
            } else if (value.type === 'thinking_delta') {
              const text = value.text;
              if (text) {
                await record({ kind: 'model_event', turnIndex, event: { ...value, text } });
                await emit({ type: 'thinking.delta', turnIndex, messageId, text });
              }
            } else if (value.type === 'tool_call_delta') {
              await record({ kind: 'model_event', turnIndex, event: value });
              await emit({
                type: 'tool.arguments.delta',
                turnIndex,
                callIndex: value.callIndex,
                delta: value.delta,
              });
            } else {
              response = validateResponse(value.response);
              if (
                response.transcriptMessage.protocol &&
                response.transcriptMessage.protocol.adapter !== input.adapter.id
              )
                throw new AgentError('MODEL_PROTOCOL_ERROR');
              output.text = response.text;
              await record({ kind: 'response', turnIndex, response });
              usage.set(callUsage, response.usage);
            }
          }
          if (!response) throw new AgentError('MODEL_PROTOCOL_ERROR');
          control.check();
          if (response.stop === 'truncated') throw new LoopStop('OUTPUT_TRUNCATED');
          if (response.stop === 'error')
            throw new AgentError(response.errorCode ?? 'PROVIDER_UNAVAILABLE');
          if (response.stop === 'aborted') throw new AgentError('PROVIDER_UNAVAILABLE');
        } finally {
          callControl.close();
          // A non-cooperative iterator cannot block cancellation or initiate further work.
          try {
            void Promise.resolve(iterator?.return?.()).catch(() => {});
          } catch {
            /* Closing is best effort. */
          }
        }
        // Validate the entire batch (including IDs used in previous turns) before any side effect.
        validateNewCalls(messages, response.calls);
        const results: ActionOutcome[] = [];
        const additions: import('@lingma/shared').TranscriptMessage[] = [
          response.transcriptMessage,
        ];
        for (const call of response.calls) {
          control.check();
          const executionId = crypto.randomUUID();
          await emit({
            type: 'tool.started',
            turnIndex,
            executionId,
            callId: call.id,
            name: call.name,
          });
          control.check();
          const result = await input.registry.execute(call, {
            runId: input.runId,
            turnIndex,
            executionId,
            signal: control.signal,
          });
          results.push(result);
          await record({ kind: 'action', turnIndex, executionId, call, result });
          await emit({
            type: 'tool.completed',
            turnIndex,
            executionId,
            callId: call.id,
            resultSummary: JSON.stringify(result).slice(0, 4000),
            isError: !result.ok,
          });
          additions.push({
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            result,
            timestamp: clock.wallNow(),
          });
          control.check();
        }
        control.check();
        const nextCheckpoint: LoopCheckpoint = {
          schemaVersion: 1,
          adapterId: input.adapter.id,
          initialRequest: structuredClone(request),
          nextTurnIndex: turnIndex + 1,
          messages: [...messages, ...additions],
          lastTurn: { turnIndex, messageId, response, results },
        };
        const publishedEvents: RunEvent[] = [];
        for (const [index, call] of response.calls.entries()) {
          const result = results[index];
          if (call.name === 'propose_document_change' && result?.ok) {
            const proposal = actionSchemas.propose_document_change.result.parse(result.value);
            publishedEvents.push(
              event({
                type: 'proposal.created',
                turnIndex,
                proposalId: proposal.proposalId,
                targetDocumentId: proposal.targetDocumentId,
              }),
            );
          }
        }
        const completedEvent = event({
          type: 'turn.completed',
          turnIndex,
          usage: response.usage,
        }) as Extract<RunEvent, { type: 'turn.completed' }>;
        try {
          await input.recorder.commitTurn(
            structuredClone({
              turnIndex,
              messageId,
              response,
              results,
              checkpoint: nextCheckpoint,
              events: [...publishedEvents, completedEvent],
            }),
            control.signal,
          );
        } catch (error) {
          if (error instanceof LoopStop) throw error;
          recordingFailed = true;
          throw new AgentError('STORAGE_ERROR');
        }
        checkpoint = nextCheckpoint;
        messages = nextCheckpoint.messages;
        turns++;
        output.committed = true;
        control.check();
        if (response.stop === 'complete') {
          stopReason = 'complete';
          break;
        }
      }
  } catch (error) {
    stopReason =
      error instanceof AgentError && error.code === 'STORAGE_ERROR'
        ? 'STORAGE_ERROR'
        : control.signal.aborted
          ? (control.signal.reason as LoopStop).reason
          : error instanceof LoopStop
            ? error.reason
            : error instanceof AgentError
              ? error.code
              : 'MODEL_PROTOCOL_ERROR';
  } finally {
    control.close();
  }
  const status =
    stopReason === 'complete'
      ? 'completed'
      : stopReason === 'cancelled'
        ? 'cancelled'
        : stopReason === 'OUTPUT_TRUNCATED'
          ? 'limited'
          : 'failed';
  const result: LoopResult = {
    status,
    stopReason,
    turns,
    attemptedTurns,
    output,
    checkpoint,
    usage: usage.summary(),
    recordingFailed,
  };
  const finished = event({
    type: 'run.finished',
    status,
    stopReason,
    usage: { known: result.usage.known, complete: result.usage.complete },
    outputMessageId: output?.messageId ?? null,
  }) as Extract<RunEvent, { type: 'run.finished' }>;
  try {
    await input.recorder.finish(structuredClone(result), finished);
  } catch {
    result.status = 'failed';
    result.stopReason = 'STORAGE_ERROR';
    result.recordingFailed = true;
  }
  return result;
}
