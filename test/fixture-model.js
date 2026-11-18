import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export const model = { provider: 'test-model', modelId: 'echo' };
export function fixtureModels(onRequest) {
  const models = createModels();
  const template = openaiProvider().getModels().find((m) => m.id === 'gpt-4.1-mini');
  const stream = (m, context) => {
    const events = createAssistantMessageEventStream();
    const response = onRequest(context, m);
    if (response === undefined) return events;
    const stopReason = typeof response === 'string' ? 'stop' : 'toolUse';
    const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
      stopReason, content: typeof response === 'string' ? [{ type: 'text', text: response }] : [response],
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    events.push({ type: 'done', reason: stopReason, message });
    return events;
  };
  models.setProvider(createProvider({ id: model.provider, auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'test' } }) } }, models: [model.modelId, 'other'].map((id) => ({ ...template, provider: model.provider, id })), api: { stream, streamSimple: stream } }));
  return models;
}
