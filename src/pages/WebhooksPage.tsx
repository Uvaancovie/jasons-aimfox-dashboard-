import { useEffect, useState } from 'react';
import type { StoredWebhookEvent, WebhooksPageResponse } from '../types/aimfox';
import { useCachedPage } from '../lib/swrCache';
import { Check, Copy, Plus, Send, Trash2 } from 'lucide-react';

interface WebhooksPageProps {
  latestWebhook: StoredWebhookEvent | null;
  syncEpoch: number;
  onMetaUpdate: (meta: WebhooksPageResponse) => void;
}

const AVAILABLE_EVENTS = [
  'campaign_reply',
  'reply',
  'accepted',
  'new_connection',
  'message',
  'view',
  'lead_label_added',
  'account_logged_in',
  'account_logged_out',
];

export function WebhooksPage({
  latestWebhook,
  syncEpoch,
  onMetaUpdate,
}: WebhooksPageProps) {
  const { data, loading, error, refresh, mutate } = useCachedPage<WebhooksPageResponse>(
    '/api/pages/webhooks',
  );

  const [name, setName] = useState('Aurora Real-Time Stream');
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([
    'campaign_reply',
    'accepted',
    'new_connection',
    'account_logged_out',
  ]);
  const [includeAuthHeader, setIncludeAuthHeader] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [testEventType, setTestEventType] = useState('campaign_reply');
  const [copiedBlock, setCopiedBlock] = useState<'url' | 'vue' | null>(null);

  useEffect(() => {
    if (data) {
      onMetaUpdate(data);
      if (!url) setUrl(data.webhookEndpointUrl);
      setIncludeAuthHeader(data.webhookSecretConfigured);
    }
  }, [data, onMetaUpdate, url]);

  useEffect(() => {
    if (syncEpoch > 0) {
      refresh({ force: true });
    }
  }, [syncEpoch, refresh]);

  useEffect(() => {
    if (!latestWebhook) return;
    mutate((prev) => {
      if (!prev) return prev;
      if (prev.webhookEvents.some((e) => e.id === latestWebhook.id)) return prev;
      return {
        ...prev,
        webhookEvents: [latestWebhook, ...prev.webhookEvents].slice(0, 200),
      };
    });
  }, [latestWebhook, mutate]);

  const toggleEvent = (evt: string) => {
    setSelectedEvents((prev) =>
      prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt],
    );
  };

  const handleCreateWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/aimfox/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          url,
          events: selectedEvents,
          includeAuthHeader,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to register webhook');
      await refresh({ force: true, silent: true });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create webhook');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteWebhook = async (id: string) => {
    const res = await fetch(`/api/aimfox/webhooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      await refresh({ force: true, silent: true });
    }
  };

  const handleTriggerTestWebhook = async () => {
    setTestingWebhook(true);
    try {
      const res = await fetch('/api/webhooks/aimfox/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: testEventType }),
      });
      const json = (await res.json()) as { event?: StoredWebhookEvent };
      if (res.ok && json.event) {
        mutate((prev) => {
          if (!prev) return prev;
          if (prev.webhookEvents.some((e) => e.id === json.event!.id)) return prev;
          return {
            ...prev,
            webhookEvents: [json.event!, ...prev.webhookEvents].slice(0, 200),
          };
        });
      }
    } finally {
      setTestingWebhook(false);
    }
  };

  const handleClearLog = async () => {
    await fetch('/api/webhooks/events', { method: 'DELETE' });
    mutate((prev) => (prev ? { ...prev, webhookEvents: [] } : prev));
  };

  const copyText = (text: string, key: 'url' | 'vue') => {
    navigator.clipboard.writeText(text);
    setCopiedBlock(key);
    setTimeout(() => setCopiedBlock(null), 1800);
  };

  if (loading && !data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 h-80 bg-white border border-slate-200 rounded-lg" />
          <div className="lg:col-span-6 h-80 bg-white border border-slate-200 rounded-lg" />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center justify-between gap-4 text-sm text-red-800">
        <span>{error}</span>
        <button
          type="button"
          onClick={() => refresh({ force: true })}
          className="px-3 py-1 text-xs font-medium bg-white border border-red-200 rounded hover:bg-red-100 cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const vueSnippet = `<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

// Connects to this Express/Vercel Aimfox cached proxy & webhook stream
// Workspace: ${data.customer.workspaceName} (${data.customer.workspaceId})
const overview = ref<any>(null)
const liveEvents = ref<any[]>([])
const selectedAccountId = ref('all')
let pollTimer: ReturnType<typeof setInterval> | null = null

async function fetchMetrics() {
  const res = await fetch(\`/api/pages/overview?range=30d&accountId=\${selectedAccountId.value}\`)
  overview.value = await res.json()
  liveEvents.value = overview.value.webhookEvents || []
}

onMounted(async () => {
  await fetchMetrics()
  pollTimer = setInterval(async () => {
    const res = await fetch('/api/webhooks/events')
    const data = await res.json()
    liveEvents.value = data.events || []
  }, 10000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>`;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-base font-semibold text-slate-900">
            Aimfox v3 Webhook Receiver
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Register this endpoint in Aimfox to stream events without hitting the 60 req/min API limit
          </p>

          <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-md flex items-center justify-between gap-3">
            <code className="text-xs font-mono text-slate-800 truncate">
              {data.webhookEndpointUrl}
            </code>
            <button
              type="button"
              onClick={() => copyText(data.webhookEndpointUrl, 'url')}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 shrink-0 cursor-pointer"
            >
              {copiedBlock === 'url' ? (
                <Check className="w-3.5 h-3.5 text-emerald-700" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>{copiedBlock === 'url' ? 'Copied' : 'Copy URL'}</span>
            </button>
          </div>

          <form onSubmit={handleCreateWebhook} className="mt-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Webhook Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:border-teal-700"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Target HTTPS URL
                </label>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  required
                  className="w-full px-3 py-1.5 text-sm font-mono border border-slate-200 rounded-md focus:outline-none focus:border-teal-700"
                />
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-700 mb-2">
                Subscribed Events
              </div>
              <div className="flex flex-wrap gap-1.5">
                {AVAILABLE_EVENTS.map((evt) => {
                  const active = selectedEvents.includes(evt);
                  return (
                    <button
                      key={evt}
                      type="button"
                      onClick={() => toggleEvent(evt)}
                      className={`px-2.5 py-1 text-xs font-mono rounded-md border transition-colors cursor-pointer ${
                        active
                          ? 'bg-teal-700 text-white border-teal-700'
                          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {evt}
                    </button>
                  );
                })}
              </div>
            </div>

            <label
              className={`flex items-center gap-2 text-xs ${
                data.webhookSecretConfigured ? 'text-slate-700 cursor-pointer' : 'text-slate-400'
              }`}
            >
              <input
                type="checkbox"
                checked={data.webhookSecretConfigured && includeAuthHeader}
                disabled={!data.webhookSecretConfigured}
                onChange={(e) => setIncludeAuthHeader(e.target.checked)}
                className="rounded border-slate-300 text-teal-700 focus:ring-teal-700"
              />
              <span>
                {data.webhookSecretConfigured ? (
                  <>
                    Attach server <code className="font-mono">Authorization: Bearer</code> header
                  </>
                ) : (
                  'Optional Authentication Header skipped (no AIMFOX_WEBHOOK_SECRET set — endpoint accepts Aimfox events openly)'
                )}
              </span>
            </label>

            {errorMsg && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2.5">
                {errorMsg}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-slate-500">
                {data.webhooks.length} active webhook{data.webhooks.length === 1 ? '' : 's'} registered on Aimfox
              </span>
              <button
                type="submit"
                disabled={submitting || selectedEvents.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{submitting ? 'Registering...' : 'Register on Aimfox'}</span>
              </button>
            </div>
          </form>

          {data.webhooks.length > 0 && (
            <div className="mt-5 pt-4 border-t border-slate-200 divide-y divide-slate-100">
              {data.webhooks.map((wh) => (
                <div key={wh.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900">{wh.name}</div>
                    <div className="text-[11px] font-mono text-slate-500 truncate">{wh.url}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {wh.events?.join(', ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteWebhook(wh.id)}
                    aria-label={`Delete webhook ${wh.name}`}
                    className="p-1.5 text-slate-400 hover:text-red-700 rounded cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg flex flex-col">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Live Ingestion Inspector
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Idempotent payload log synced in real time
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={testEventType}
                onChange={(e) => setTestEventType(e.target.value)}
                aria-label="Test webhook event type"
                className="px-2.5 py-1.5 text-xs font-mono border border-slate-200 rounded-md bg-white text-slate-800"
              >
                {AVAILABLE_EVENTS.map((evt) => (
                  <option key={evt} value={evt}>
                    {evt}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={testingWebhook}
                onClick={handleTriggerTestWebhook}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-teal-700 text-white rounded-md hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{testingWebhook ? 'Sending...' : 'Send Test'}</span>
              </button>
              {data.webhookEvents.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearLog}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="divide-y divide-slate-100 overflow-y-auto max-h-[420px] flex-1">
            {data.webhookEvents.map((evt) => (
              <div key={evt.id} className="p-4">
                <div className="flex items-center justify-between gap-2 text-xs mb-2">
                  <div className="font-mono font-semibold text-teal-700">
                    {evt.event_type}
                    <span className="text-slate-400 font-normal"> · {evt.id}</span>
                  </div>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {new Date(evt.received_at).toLocaleTimeString()}
                  </span>
                </div>
                <pre className="text-[11px] font-mono bg-slate-50 border border-slate-200 rounded p-2.5 overflow-x-auto text-slate-700">
                  {JSON.stringify(evt.event, null, 2)}
                </pre>
              </div>
            ))}
            {data.webhookEvents.length === 0 && (
              <div className="p-10 text-center text-sm text-slate-500">
                No webhook deliveries recorded yet. Use Send Test above or trigger an event from Aimfox.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Vue 3 Real-Time Client Integration
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Drop-in Vue 3 Composition API composable wired to this cached Aimfox backend
            </p>
          </div>
          <button
            type="button"
            onClick={() => copyText(vueSnippet, 'vue')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedBlock === 'vue' ? (
              <Check className="w-3.5 h-3.5 text-emerald-700" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span>{copiedBlock === 'vue' ? 'Copied Vue Code' : 'Copy Vue Snippet'}</span>
          </button>
        </div>
        <pre className="p-5 text-xs font-mono bg-slate-900 text-slate-100 overflow-x-auto leading-relaxed">
          {vueSnippet}
        </pre>
      </div>
    </div>
  );
}
