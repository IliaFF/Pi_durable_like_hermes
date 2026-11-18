export class ApiError extends Error {
  constructor(platform, code, retryAfter, ambiguous = false) {
    super(`${platform} request failed (${code})`);
    Object.assign(this, { code, retryAfter, ambiguous });
  }
}

async function jsonRequest(platform, url, body, signal, fetcher) {
  try {
    const response = await fetcher(url, {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(40_000), ...(signal ? [signal] : [])]),
    });
    if (response.status >= 500) throw new ApiError(platform, response.status, 0, true);
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(platform, 'transport', 0, true);
  }
}

const words = (input) => new Set((input ?? '').split(/[\s,]+/).filter(Boolean));
const id = (value) => Number.isSafeInteger(value) ? String(value) : undefined;
const acl = (scope) => (event) => event.sender && scope.users.has(event.sender)
  && (event.group ? scope.groups.has(event.chat) : event.chat === event.sender);

export function telegramEvent(update, bot) {
  const m = update.message;
  if (m?.from?.is_bot || m?.sender_chat || !m?.text?.trim()) return;
  const group = ['group', 'supergroup'].includes(m.chat.type);
  if (!group && m.chat.type !== 'private') return;
  if (group && m.reply_to_message?.from?.id !== bot.id && !m.entities?.some(({ type, offset, length, user }) =>
    (type === 'text_mention' && user?.id === bot.id) ||
    (['mention', 'bot_command'].includes(type) && m.text.slice(offset, offset + length).toLowerCase().endsWith(`@${bot.username.toLowerCase()}`)))) return;
  if (!id(m.chat.id) || !id(update.update_id)) return;
  const [command] = m.text.split(/\s/, 1);
  const text = command.toLowerCase() === `/model@${bot.username.toLowerCase()}` ? `/model${m.text.slice(command.length)}` : m.text;
  return { platform: 'telegram', event: id(update.update_id), sender: id(m.from?.id), chat: id(m.chat.id), group,
    thread: m.is_topic_message ? m.message_thread_id : undefined, message: m.message_id, sentAt: m.date, text };
}

export function vkEvent(update, groupId) {
  const m = update.type === 'message_new' && update.object?.message;
  if (!m || m.out || m.from_id <= 0 || !m.text?.trim() || !id(m.peer_id)) return;
  const group = m.peer_id >= 2_000_000_000;
  const mentions = new RegExp(`\\[(?:club|public)${groupId}\\|[^\\]]*\\]`, 'i');
  if (group && m.reply_message?.from_id !== -Number(groupId) && !mentions.test(m.text)) return;
  const message = m.conversation_message_id || m.id;
  if (!id(message)) return;
  return { platform: 'vk', event: `${m.peer_id}:${message}`, sender: id(m.from_id), chat: id(m.peer_id), group, sentAt: m.date, text: m.text };
}

export function createPlatforms(env, fetcher = fetch) {
  const platforms = [];
  if (env.TELEGRAM_BOT_TOKEN) {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!/^\d+:[\w-]+$/.test(token)) throw new Error('Invalid Telegram bot token format');
    const allowed = acl({ users: words(env.TELEGRAM_ALLOWED_USERS), groups: words(env.TELEGRAM_ALLOWED_GROUPS) });
    let bot;
    const call = async (method, params, signal) => {
      const data = await jsonRequest('telegram', `https://api.telegram.org/bot${token}/${method}`, new URLSearchParams(params), signal, fetcher);
      if (data.ok === false) throw new ApiError('telegram', data.error_code, data.parameters?.retry_after);
      if (data.ok !== true) throw new ApiError('telegram', 'protocol', 0, true);
      return data.result;
    };
    platforms.push({ name: 'telegram', inspect: () => call('getMe'), async poll(store, signal) {
      bot ??= await call('getMe', {}, signal);
      const cursor = store.cursor('telegram');
      const updates = await call('getUpdates', { timeout: 25, allowed_updates: '["message"]', ...(cursor && { offset: cursor }) }, signal);
      if (updates.length) store.ingest('telegram', Math.max(...updates.map((u) => u.update_id)) + 1,
        updates.map((u) => telegramEvent(u, bot)).filter((e) => e && allowed(e)));
    }, send(event, text) {
      return call('sendMessage', { chat_id: event.chat, text,
        ...(event.thread !== undefined && { message_thread_id: event.thread }),
        reply_parameters: JSON.stringify({ message_id: event.message, allow_sending_without_reply: true }) });
    } });
  }
  if (env.VK_GROUP_TOKEN) {
    const groupId = env.VK_GROUP_ID;
    if (!/^[1-9]\d*$/.test(groupId ?? '')) throw new Error('VK_GROUP_ID must be a positive integer');
    const allowed = acl({ users: words(env.VK_ALLOWED_USERS), groups: words(env.VK_ALLOWED_PEERS) });
    let poll;
    const call = async (method, params, signal) => {
      const data = await jsonRequest('vk', `https://api.vk.com/method/${method}`,
        new URLSearchParams({ ...params, access_token: env.VK_GROUP_TOKEN, v: '5.199' }), signal, fetcher);
      if (data.error) throw new ApiError('vk', data.error.error_code);
      if (!Object.hasOwn(data, 'response')) throw new ApiError('vk', 'protocol', 0, true);
      return data.response;
    };
    platforms.push({ name: 'vk', inspect: () => call('groups.getLongPollSettings', { group_id: groupId }), async poll(store, signal) {
      poll ??= await call('groups.getLongPollServer', { group_id: groupId }, signal);
      const url = new URL(poll.server);
      if (url.protocol !== 'https:') throw new ApiError('vk', 'poll-url');
      url.search = new URLSearchParams({ act: 'a_check', key: poll.key, ts: store.cursor('vk') ?? poll.ts, wait: 25 });
      const params = new URLSearchParams(url.searchParams);
      url.search = '';
      const data = await jsonRequest('vk', url, params, signal, fetcher);
      if ([2, 3].includes(data.failed)) {
        poll = await call('groups.getLongPollServer', { group_id: groupId }, signal);
        if (data.failed === 3 || data.ts) store.ingest('vk', data.failed === 3 ? poll.ts : data.ts, []);
      } else if (data.failed === 1 || Array.isArray(data.updates)) {
        if (!/^\d+$/.test(String(data.ts))) throw new ApiError('vk', 'poll-cursor');
        store.ingest('vk', data.ts, (data.updates ?? []).map((update) => vkEvent(update, groupId)).filter((e) => e && allowed(e)));
      } else throw new ApiError('vk', 'poll-protocol');
    }, send(event, text, randomId) {
      return call('messages.send', { peer_id: event.chat, message: text, random_id: randomId });
    } });
  }
  return platforms;
}
