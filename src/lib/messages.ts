export type MessageKind = 'contact' | 'newsletter' | 'launch';
export type Message = {
  id: string; kind: MessageKind; name: string; email: string;
  message: string; read: boolean; createdAt: string;
};
import { getSupabase } from './supabase';
import { broadcastStoreEvent, subscribeToStoreEvent } from './realtime';

type MessageRow = {
  id: string; kind: string; name: string; email: string;
  message: string; read: boolean; created_at: string;
};
const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  kind: (r.kind === 'newsletter' || r.kind === 'launch' ? r.kind : 'contact') as MessageKind,
  name: r.name ?? '', email: r.email ?? '', message: r.message ?? '',
  read: r.read, createdAt: r.created_at,
});
const KEY = 'huda.messages.v1';
function readAll(): Message[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Message[];
  } catch { /* ignore */ }
  return [];
}
function writeAll(list: Message[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
export function listMessages(): Message[] {
  return readAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function unreadMessages(): number {
  return readAll().filter((m) => !m.read).length;
}
export function submitMessage(input: { kind: MessageKind; name?: string; email: string; message?: string }): Message {
  const m: Message = {
    id: `msg-${Date.now().toString(36)}`, kind: input.kind,
    name: (input.name ?? '').trim(), email: input.email.trim().toLowerCase(),
    message: (input.message ?? '').trim(), read: false, createdAt: new Date().toISOString(),
  };
  writeAll([m, ...readAll()]);
  broadcastStoreEvent('messages:changed', { action: 'submit', id: m.id });
  void (async () => {
    try {
      const sb = getSupabase();
      if (!sb) return;
      await sb.from('messages').insert({
        id: m.id, kind: m.kind, name: m.name, email: m.email,
        message: m.message, read: m.read, created_at: m.createdAt,
      });
    } catch { /* ignore */ }
  })();
  return m;
}
export function markMessageRead(id: string, read: boolean) {
  writeAll(readAll().map((m) => (m.id === id ? { ...m, read } : m)));
  broadcastStoreEvent('messages:changed', { action: 'read', id, read });
  void (async () => {
    try {
      const sb = getSupabase();
      if (!sb) return;
      await sb.from('messages').update({ read }).eq('id', id);
    } catch { /* ignore */ }
  })();
}
export function deleteMessage(id: string) {
  writeAll(readAll().filter((m) => m.id !== id));
  broadcastStoreEvent('messages:changed', { action: 'delete', id });
  void (async () => {
    try {
      const sb = getSupabase();
      if (!sb) return;
      await sb.from('messages').delete().eq('id', id);
    } catch { /* ignore */ }
  })();
}
export async function hydrateMessages(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data, error } = await sb.from('messages').select('*');
    if (error || !data) return;
    const remote = (data as MessageRow[]).map(toMessage);
    const local = readAll();
    const ids = new Set(local.map((m) => m.id));
    writeAll([...local, ...remote.filter((m) => !ids.has(m.id))]);
  } catch { /* ignore — demo mode keeps local data */ }
}

if (typeof window !== 'undefined') {
  subscribeToStoreEvent('messages:changed', () => {
    void hydrateMessages();
  });
}
