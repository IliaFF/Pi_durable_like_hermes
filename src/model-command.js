export const DEFAULT_MODEL = { provider: 'openrouter', modelId: 'deepseek/deepseek-v4.1-flash-1017' };
const key = ({ provider, modelId }) => `${provider}/${modelId}`;

function canUse(provider, event, owners) {
  return provider !== 'openai-codex' || (event.group === false && event.sender === event.chat && owners[event.platform] === event.sender && Boolean(event.sender));
}

export async function selectedModel(store, models, row, fallback, owners) {
  const saved = store.getChatModel(row.scope);
  return saved && canUse(saved.provider, JSON.parse(row.payload), owners) &&
    models.getModel(saved.provider, saved.modelId) && await models.checkAuth(saved.provider) ? saved : fallback;
}

export async function modelCommand(store, models, fallback, row, owners) {
  const event = JSON.parse(row.payload);
  const match = /^\/model(?:\s+([\s\S]*))?$/i.exec(event.text.trim());
  if (!match) return undefined;
  const query = (match[1] ?? '').trim().toLowerCase();
  const providers = ['openrouter', 'openai', 'openai-codex'].filter((provider) => canUse(provider, event, owners));
  const catalog = (await Promise.all(providers.map((provider) => models.getAvailable(provider)))).flat()
    .map(({ provider, id, name }) => ({ provider, modelId: id, name }));
  const current = await selectedModel(store, models, row, fallback, owners);
  const candidates = catalog.filter((model) => key(model).toLowerCase() === query || model.modelId.toLowerCase() === query);
  const choice = candidates.find((model) => key(model).toLowerCase() === query) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (choice || query === 'default') {
    if (event.group && (!event.sender || owners[event.platform] !== event.sender)) return 'В группе модель может сменить только владелец бота.';
    store.setChatModel(row.scope, query === 'default' ? null : choice);
    return `Модель для этого чата: ${key(query === 'default' ? fallback : choice)}.`;
  }
  const matches = catalog.filter((model) => `${key(model)} ${model.name}`.toLowerCase().includes(query));
  if (!query) matches.sort((a, b) => Number(key(b) === key(current)) - Number(key(a) === key(current)) ||
    Number(b.provider === 'openai-codex') - Number(a.provider === 'openai-codex') || a.name.localeCompare(b.name));
  const list = matches.slice(0, 12).map((model) => `/model ${key(model)}`).join('\n');
  return [`Сейчас: ${key(current)}`, list || 'Модели не найдены.',
    matches.length > 12 ? `Показано 12 из ${matches.length}. Уточни поиск: /model <название>.` : '',
    'Для сброса на модель по умолчанию: /model default.'].filter(Boolean).join('\n\n');
}
