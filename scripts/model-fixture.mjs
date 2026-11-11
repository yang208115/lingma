import { createServer } from 'node:http';

/** Local HTTP fixture for browser tests: production still uses the real pi-ai adapter. */
export async function startModelFixture(port = 4179) {
  const failed = new Set();
  const guideFailures = new Map();
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4_000_000) {
        res.writeHead(413).end();
        return;
      }
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const messages = body.messages ?? [];
    let task;
    try {
      task = JSON.parse(messages.find((message) => message.role === 'user')?.content ?? '{}');
    } catch {
      task = {};
    }
    const tools = messages.filter((message) => message.role === 'tool');
    const documentTools = tools.filter((message) => message.tool_call_id !== 'fixture-skill');
    if (body.model === 'fixture-thinking' && body.reasoning_effort !== 'medium') {
      res.writeHead(400).end();
      return;
    }
    const identifier = `${task.task}:${task.target?.documentId}`;
    if (body.model === 'fixture-fail-once' && tools.length === 1 && !failed.has(identifier)) {
      failed.add(identifier);
      res
        .writeHead(500, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'synthetic interruption' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    const timers = new Set();
    const wait = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          resolve();
        }, ms);
        timers.add(timer);
      });
    res.on('close', () => {
      for (const timer of timers) clearTimeout(timer);
    });
    const emit = (delta, finish = null) => {
      if (!res.destroyed)
        res.write(
          `data: ${JSON.stringify({ id: `response-${tools.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
    };
    const slow = body.model === 'fixture-slow';
    if (slow) await wait(300);
    if (body.model === 'fixture-thinking') {
      emit({ role: 'assistant', reasoning_content: `第${tools.length + 1}轮：先核对` });
      await wait(100);
      emit({ reasoning_content: '人物资料，再生成正文。' });
      if (tools.length === 0) await wait(5000);
    }
    const batchTool = body.tools?.some(
      (tool) => tool.function?.name === 'propose_basic_information_batch',
    );
    if (batchTool && tools.length > 0) {
      emit({
        role: 'assistant',
        content: JSON.stringify({
          guidance: {
            reply: '已整理本轮相关设定，采用后保存。',
            question: '你希望故事偏甜蜜日常，还是带一点暗恋的酸涩？',
          },
        }),
      });
      emit({}, 'stop');
    } else if (batchTool || task.expectedShape?.items) {
      if (body.model === 'fixture-guide-retry' && task.idea?.startsWith('重试原始输入：')) {
        const attempts = guideFailures.get(task.idea) ?? 0;
        guideFailures.set(task.idea, attempts + 1);
        if (attempts < 2) {
          emit({ role: 'assistant', content: 'invalid json for retry test' });
          emit({}, 'stop');
          res.end();
          return;
        }
      }
      const sample = task.expectedShape.items?.[0] ?? {
        tempId: 'story_premise_1',
        kind: 'story_premise',
        title: '名称',
        targetDocumentId: null,
        content: '共同寻找失去的明天。',
        reason: '根据作者想法整理',
        openQuestions: [],
        data: { summary: '', fields: {}, nature: 'rule', links: [], sources: [], source: 'ai' },
      };
      const names = {
        story_premise: '重置之城',
        worldbuilding: '十分钟法则',
        character: '邮差林舟',
        core_conflict: '记忆与真相',
        master_outline: '寻找明天',
        timeline_event: '午夜重置',
        foreshadow: '停摆怀表',
        narrative_style: '雨夜叙事',
      };
      const target = task.targetDocumentId
        ? task.existing.find((e) => e.document.id === task.targetDocumentId)
        : null;
      const count = target ? 1 : (task.targetCount ?? 1);
      const items = Array.from({ length: count }, (_, index) => ({
        ...sample,
        tempId: `${sample.kind}_${index + 1}`,
        title: (names[sample.kind] ?? sample.kind) + (count > 1 ? ` ${index + 1}` : ''),
        targetDocumentId: target?.document.id ?? null,
        data: {
          ...sample.data,
          summary: '在重置之城寻找失去的明天。',
          fields: Object.fromEntries(
            Object.keys(sample.data.fields).map((key) => [
              key,
              `设定：${key}，每次选择都必须付出代价。`,
            ]),
          ),
          links:
            sample.kind === 'character' && task.upstream.some((c) => c.tempId === 'worldbuilding_1')
              ? [{ targetId: 'worldbuilding_1', label: '生活于', nature: 'rule' }]
              : [],
        },
      }));
      const guidance = task.expectedShape.guidance
        ? {
            reply: '我先整理你的故事定位。主题方向仅作为建议，采用后才会保存。',
            question: '你希望故事偏甜蜜日常，还是带一点暗恋的酸涩？',
          }
        : undefined;
      if (guidance) {
        const existing = task.elementContext.find((group) => group.kind === sample.kind)?.items[0];
        for (const item of items) item.targetDocumentId = existing?.documentId ?? null;
        if (body.model === 'fixture-guide-linked') {
          const ids = ['character_alpha', 'character_beta'];
          items.splice(
            0,
            items.length,
            ...ids.map((tempId, index) => ({
              ...sample,
              tempId,
              kind: 'character',
              title: index ? '角色乙' : '角色甲',
              data: {
                ...sample.data,
                fields: { role: '主角' },
                links: [{ targetId: ids[1 - index], label: '互相信任', nature: 'planned' }],
              },
            })),
          );
        }
        if (body.model === 'fixture-guide-batch') {
          items.splice(
            0,
            items.length,
            ...['story_premise', 'character', 'core_conflict'].map((kind) => {
              const existing = task.elementContext.find((group) => group.kind === kind)?.items[0];
              return {
                ...sample,
                tempId: `${kind}_1`,
                kind,
                title: names[kind],
                targetDocumentId: existing?.documentId ?? null,
                content: task.idea,
                data: { ...sample.data, fields: {} },
              };
            }),
          );
        }
      }
      if (batchTool) {
        emit({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'fixture-basic-information-batch',
              type: 'function',
              function: {
                name: 'propose_basic_information_batch',
                arguments: JSON.stringify({ items }),
              },
            },
          ],
        });
        emit({}, 'tool_calls');
      } else {
        emit({
          role: 'assistant',
          content: JSON.stringify({ items, ...(guidance ? { guidance } : {}) }),
        });
        emit({}, 'stop');
      }
    } else if (task.workflowNode) {
      if (tools.length === 0) {
        const node = task.workflowNode;
        const draftText = '林舟用左手拨开窗栓。雨声里，来客的说辞露出了破绽。';
        const text =
          node.stage === 'agent' && task.taskType === 'discussion'
            ? task.outputFormat?.includes('讨论结论')
              ? `> 本地模拟模型，用于验证辩论运行。\n\n## 共识\n开篇需要提供足够的动机线索。\n\n## 分歧\n正方支持尽早揭露身世，反方主张保留悬念。\n\n## 建议\n第一章揭示局部线索，完整真相留待关键转折。\n\n汇总已收到 ${task.upstream.length} 份相连节点的发言。`
              : `> 本地模拟模型，用于验证辩论运行。\n\n## 第 ${node.round + 1} 轮 · ${node.key.startsWith('pro') ? '正方' : '反方'}\n${node.key.startsWith('pro') ? '尽早提供主角身世有助于建立目标与动机。' : '完整揭露可能削弱悬念，应区分动机线索与最终真相。'}\n\n${node.round ? `回应收到的发言：${task.upstream.map((item) => item.from).join('、')}。保留不同意见，提出折中方案。` : '独立提出首轮观点。'}`
            : node.stage === 'plan'
              ? '本章目标：林舟在雨夜检查来客的说辞，结尾留下铜铃线索。'
              : node.stage === 'analysis'
                ? '保持限知视角，保留来客的秘密。'
                : node.stage === 'review'
                  ? '无重要问题'
                  : task.taskType === 'basic_information'
                    ? '## [世界] 十分钟法则\n> 每次回溯最多十分钟。\n规则与使用条件：设定：每次选择都必须付出代价\n\n## [人物] 邮差林舟\n> 失去记忆的邮差。\n外在目标：寻找失去的明天'
                    : task.taskType === 'master_outline'
                      ? '# 雾港故事总纲\n\n## 起点\n林舟在雾港遇到失忆的来客。\n## 转折\n来客发现魔法的代价。\n## 高潮与结局\n林舟付出记忆换回真相。'
                      : task.taskType === 'story_events'
                        ? '## 雨夜抵港\n时间：第一天\n概述：来客出现\n来客雨夜抵港，向林舟求助。\n\n## 记忆的代价\n时间：第二天\n概述：揭示规则\n林舟发现施法需要付出记忆。'
                        : task.taskType === 'chapter_planning'
                          ? Array.from(
                              { length: task.chapterCount ?? 3 },
                              (_, index) =>
                                `## 第${index + 1}章 雨港的选择\n概述：第 ${index + 1} 次选择推动关系变化。\n### 本章目标\n逐步建立信任。\n### 场景与转折\n承接前章的线索，在雨港作出新的选择。\n### 情节边界\n后续真相留给下一章。`,
                            ).join('\n\n')
                          : task.taskType === 'worldbuilding'
                            ? '## [世界] 雾港世界观\n> 海雾中的港城以记忆交换魔法。\n规则与使用条件：施法必须交出一段记忆\n代价与限制：失去珍贵回忆\n禁忌：不能复活死者'
                            : task.targetDocumentId
                              ? draftText
                              : `# 雨夜来客\n\n${draftText}`;
        emit({ role: 'assistant', content: text });
        emit({}, 'stop');
      } else {
        emit({ role: 'assistant', content: '本阶段产物已提交。' });
        emit({}, 'stop');
      }
    } else if (body.model === 'fixture-master-outline') {
      if (tools.length === 0) {
        emit({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'fixture-master-outline',
              type: 'function',
              function: {
                name: 'propose_master_outline',
                arguments: JSON.stringify({
                  title: '雾港故事总纲',
                  content:
                    '## 故事起点\n林舟收到一枚铜铃。\n## 主要转折\n苏禾揭开铜铃的秘密。\n## 高潮与结局\n两人查明真相，离开雾港。',
                  reason: '根据基本信息规划完整故事。',
                  citations: [],
                }),
              },
            },
          ],
        });
        emit({}, 'tool_calls');
      } else {
        emit({ role: 'assistant', content: '已提交故事总纲候选，请确认保存。' });
        emit({}, 'stop');
      }
    } else if (body.model === 'fixture-skills' && tools.length === 0) {
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const catalog = JSON.parse(system.split('可用 Skill 目录（JSON 数据）：\n')[1]);
      const skill = catalog.find((entry) => entry.name === '写作助手');
      emit({ role: 'assistant' });
      emit({
        tool_calls: [
          {
            index: 0,
            id: 'fixture-skill',
            type: 'function',
            function: {
              name: 'load_skill',
              arguments: JSON.stringify({ versionId: skill.versionId }),
            },
          },
        ],
      });
      emit({}, 'tool_calls');
    } else if (task.target && documentTools.length === 0) {
      const ref =
        task.allowedDocuments.find((item) => item.kind === 'character') ?? task.allowedDocuments[0];
      emit({ role: 'assistant' });
      emit({
        tool_calls: [
          {
            index: 0,
            id: 'fixture-read',
            type: 'function',
            function: {
              name: 'read_document',
              arguments: JSON.stringify({ documentId: ref.documentId, versionId: ref.versionId }),
            },
          },
        ],
      });
      emit({}, 'tool_calls');
    } else if (
      task.target &&
      documentTools.length === 1 &&
      body.tools?.some((tool) => tool.function?.name === 'propose_document_change')
    ) {
      const result = JSON.parse(documentTools[0].content);
      emit({ role: 'assistant' });
      emit({
        tool_calls: [
          {
            index: 0,
            id: 'fixture-proposal',
            type: 'function',
            function: {
              name: 'propose_document_change',
              arguments: JSON.stringify({
                content: '林舟用左手拨开窗栓。',
                reason: '遵循冻结人物资料',
                citations: result.ok ? [result.value.citationId] : [],
              }),
            },
          },
        ],
      });
      emit({}, 'tool_calls');
    } else {
      const text = task.target ? '林舟用左手拨开窗栓。' : 'OK';
      for (const part of text.match(/.{1,3}/gu) ?? []) {
        emit({ role: 'assistant', content: part });
        await wait(slow ? 500 : 30);
        if (res.destroyed) return;
      }
      emit({}, 'stop');
    }
    if (!res.destroyed) {
      res.write(
        `data: ${JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`,
      );
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
