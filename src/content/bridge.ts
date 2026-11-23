// Isolated-world side of the channel to main-world.ts (window.postMessage, data only).

const TAG = '__vidioma';

type Handler = (payload: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

export class MainBridge {
  private handlers = new Map<string, Set<Handler>>();
  private buffered = new Map<string, unknown[]>();
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  constructor() {
    window.addEventListener('message', (ev: MessageEvent) => {
      const d = ev.data as { [TAG]?: string; type?: string; payload?: unknown; replyTo?: string } | null;
      if (ev.source !== window || !d || d[TAG] !== 'm2i' || typeof d.type !== 'string') return;
      if (d.type === 'reply' && d.replyTo) {
        const p = this.pending.get(d.replyTo);
        if (!p) return;
        this.pending.delete(d.replyTo);
        clearTimeout(p.timer);
        const r = d.payload as { ok: boolean; result: unknown };
        if (r?.ok) p.resolve(r.result);
        else p.reject(new Error(String(r?.result ?? 'request failed')));
        return;
      }
      const hs = this.handlers.get(d.type);
      if (hs?.size) for (const h of hs) h(d.payload);
      else {
        // Keep early events (e.g. a manifest parsed before we subscribed) for late subscribers.
        const list = this.buffered.get(d.type) ?? [];
        list.push(d.payload);
        if (list.length > 20) list.shift();
        this.buffered.set(d.type, list);
      }
    });
  }

  on(type: string, handler: Handler): () => void {
    let hs = this.handlers.get(type);
    if (!hs) this.handlers.set(type, (hs = new Set()));
    hs.add(handler);
    const early = this.buffered.get(type);
    if (early) {
      this.buffered.delete(type);
      for (const p of early) handler(p);
    }
    return () => hs!.delete(handler);
  }

  request<T = unknown>(type: string, payload: unknown = {}, timeoutMs = 15000): Promise<T> {
    const id = `r${++this.seq}_${Math.random().toString(36).slice(2)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type}: timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      window.postMessage({ [TAG]: 'i2m', id, type, payload }, '*');
    });
  }

  /** Fetch a URL from the page's context (same cookies / origin as the site). */
  async pageFetch(url: string): Promise<string> {
    const r = await this.request<{ status: number; text: string }>('fetch', { url }, 30000);
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    return r.text;
  }
}
