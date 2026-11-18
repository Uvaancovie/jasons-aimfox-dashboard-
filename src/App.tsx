import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DashboardOverviewResponse,
  StoredWebhookEvent,
  TimeRange,
} from './types/aimfox';
import { OverviewView } from './components/OverviewView';
import { UserPerformanceView } from './components/UserPerformanceView';
import { CampaignsTemplatesView } from './components/CampaignsTemplatesView';
import { LeadsConversationsView } from './components/LeadsConversationsView';
import { WebhooksVueView } from './components/WebhooksVueView';
import {
  Activity,
  BarChart3,
  Download,
  Layers,
  Menu,
  RefreshCw,
  Users,
  Webhook,
  X,
} from 'lucide-react';

type NavTab = 'overview' | 'users' | 'campaigns' | 'leads' | 'webhooks';

const NAV_ITEMS: Array<{ id: NavTab; label: string; icon: typeof BarChart3 }> = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'users', label: 'User Performance', icon: Users },
  { id: 'campaigns', label: 'Campaigns', icon: Layers },
  { id: 'leads', label: 'Leads & Inbox', icon: Activity },
  { id: 'webhooks', label: 'Webhooks & Vue', icon: Webhook },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [range, setRange] = useState<TimeRange>('30d');
  const [accountId, setAccountId] = useState<string>('all');
  const [campaignId, setCampaignId] = useState<string>('all');
  const [data, setData] = useState<DashboardOverviewResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [testingWebhook, setTestingWebhook] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'polling' | 'reconnecting'>('connecting');
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);

  const rangeRef = useRef(range);
  const accountRef = useRef(accountId);
  const campaignRef = useRef(campaignId);
  rangeRef.current = range;
  accountRef.current = accountId;
  campaignRef.current = campaignId;

  const fetchOverview = useCallback(
    async (opts?: { force?: boolean; silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          range: rangeRef.current,
          accountId: accountRef.current,
          campaignId: campaignRef.current,
        });
        if (opts?.force) params.set('force', 'true');
        const res = await fetch(`/api/dashboard/overview?${params.toString()}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to load Aimfox analytics');
        setData(json as DashboardOverviewResponse);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to reach Aimfox API');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchOverview();
  }, [range, accountId, campaignId, fetchOverview]);

  // Real-time stream: uses WebSocket on Node server, clean HTTP polling on serverless (Vercel)
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let closedByCleanup = false;
    let attempt = 0;

    const startPolling = () => {
      setWsStatus('polling');
      pollTimer = setInterval(async () => {
        if (closedByCleanup) return;
        try {
          const res = await fetch('/api/webhooks/events');
          if (!res.ok) return;
          const json = (await res.json()) as { events?: StoredWebhookEvent[] };
          if (Array.isArray(json.events)) {
            setData((prev) => (prev ? { ...prev, webhookEvents: json.events! } : prev));
          }
        } catch {
          // ignore transient poll failures
        }
      }, 10_000);
    };

    const connectWs = () => {
      if (closedByCleanup) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);

      ws.onopen = () => {
        attempt = 0;
        setWsStatus('connected');
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as { type: string; payload: unknown };
          if (msg.type === 'webhook:received') {
            const incoming = msg.payload as StoredWebhookEvent;
            setData((prev) => {
              if (!prev) return prev;
              const exists = prev.webhookEvents.some((e) => e.id === incoming.id);
              if (exists) return prev;
              return {
                ...prev,
                webhookEvents: [incoming, ...prev.webhookEvents].slice(0, 200),
              };
            });
          } else if (
            msg.type === 'dashboard:synced' ||
            msg.type === 'campaign:updated' ||
            msg.type === 'webhooks:changed' ||
            msg.type === 'webhooks:cleared'
          ) {
            fetchOverview({ silent: true });
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (closedByCleanup) return;
        setWsStatus('reconnecting');
        const delay = Math.min(10000, 1000 * Math.pow(1.6, attempt));
        attempt += 1;
        reconnectTimer = setTimeout(connectWs, delay);
      };
    };

    (async () => {
      try {
        const res = await fetch('/api/health');
        if (!res.ok) {
          startPolling();
          return;
        }
        const health = (await res.json()) as { wsSupported?: boolean };
        if (closedByCleanup) return;
        if (health.wsSupported) {
          connectWs();
        } else {
          startPolling();
        }
      } catch {
        if (!closedByCleanup) startPolling();
      }
    })();

    return () => {
      closedByCleanup = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearInterval(pollTimer);
      ws?.close();
    };
  }, [fetchOverview]);

  const handleManualSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ range, accountId, campaignId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Sync failed');
      setData(json as DashboardOverviewResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleToggleCampaignState = async (
    targetCampaignId: string,
    nextState: 'ACTIVE' | 'PAUSED',
  ) => {
    const res = await fetch(`/api/aimfox/campaigns/${encodeURIComponent(targetCampaignId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: nextState }),
    });
    if (!res.ok) {
      const json = await res.json();
      setError(json.error || 'Failed to update campaign state');
      return;
    }
    await fetchOverview({ force: true, silent: true });
  };

  const handleTriggerTestWebhook = async (eventType = 'campaign_reply') => {
    setTestingWebhook(true);
    try {
      await fetch('/api/webhooks/aimfox/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType }),
      });
    } finally {
      setTestingWebhook(false);
    }
  };

  const handleExportCsv = () => {
    const params = new URLSearchParams({ range, accountId, campaignId });
    window.location.href = `/api/export/csv?${params.toString()}`;
  };

  const currentTabLabel = NAV_ITEMS.find((i) => i.id === activeTab)?.label || 'Overview';

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Mobile Sidebar Backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-slate-900/40 z-30 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Left Workspace Sidebar */}
      <aside
        className={`fixed lg:sticky top-0 left-0 z-40 h-screen w-[248px] shrink-0 bg-white border-r border-slate-200 flex flex-col justify-between transition-transform duration-200 lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div>
          <div className="h-16 px-5 border-b border-slate-200 flex items-center justify-between">
            <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
              Aurora Pulse
            </span>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="lg:hidden p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
              aria-label="Close navigation"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="px-5 py-4 border-b border-slate-100">
            <div className="text-xs font-semibold text-slate-900 truncate">
              {data?.customer.workspaceName || 'Baby George Creative'}
            </div>
            <div className="text-xs text-slate-500 truncate mt-0.5">
              {data?.customer.fullName || 'Jason Thompson'}
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              {data?.customer.email || 'jason@aurorasalesagency.com'}
            </div>
          </div>

          <nav className="p-3 space-y-1" aria-label="Dashboard sections">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Real Telemetry Footer (WS connection + Aimfox rate-limit budget) */}
        <div className="p-4 border-t border-slate-200 space-y-2.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Real-Time Stream</span>
            <span className="inline-flex items-center gap-1.5 font-medium text-slate-800">
              <span
                className={`w-2 h-2 rounded-full ${
                  wsStatus === 'connected' || wsStatus === 'polling'
                    ? 'bg-emerald-600'
                    : wsStatus === 'reconnecting'
                      ? 'bg-amber-600'
                      : 'bg-slate-400'
                }`}
              />
              <span>
                {wsStatus === 'connected'
                  ? 'WebSocket Live'
                  : wsStatus === 'polling'
                    ? 'Live Polling (10s)'
                    : wsStatus === 'reconnecting'
                      ? 'Reconnecting'
                      : 'Connecting'}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between font-mono tabular-nums text-slate-500">
            <span>API Budget</span>
            <span>
              {data?.rateLimit.requestsLastMinute ?? 0}/{data?.rateLimit.limitPerMinute ?? 60} rpm
            </span>
          </div>
          {data?.syncedAt && (
            <div className="text-[11px] font-mono tabular-nums text-slate-400">
              Synced {new Date(data.syncedAt).toLocaleTimeString()}
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb on left, 1 primary CTA on right */}
        <header className="sticky top-0 z-20 h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 -ml-1.5 text-slate-600 hover:text-slate-900 cursor-pointer"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm truncate">
              <span className="text-slate-500 truncate">
                {data?.customer.workspaceName || 'Baby George Creative'}
              </span>
              <span className="text-slate-300" aria-hidden="true">/</span>
              <h1 className="font-semibold text-slate-900 truncate">{currentTabLabel}</h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleManualSync}
              disabled={syncing}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-teal-700 text-white rounded-md hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? 'Syncing...' : 'Sync Aimfox'}</span>
            </button>
          </div>
        </header>

        {/* Workspace Filter Toolbar */}
        <div className="bg-white border-b border-slate-200 px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* Timeframe Segmented Control */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md" role="group" aria-label="Time range">
              {(['7d', '30d', '90d'] as TimeRange[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`px-3 py-1 text-xs font-mono font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    range === r
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {r.toUpperCase()}
                </button>
              ))}
            </div>

            {/* User / Account Selector */}
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              aria-label="Filter by LinkedIn account"
              className="px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-md bg-white text-slate-800 focus:outline-none focus:border-teal-700"
            >
              <option value="all">All LinkedIn Seats</option>
              {data?.accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.full_name}
                </option>
              ))}
            </select>

            {/* Campaign Selector */}
            <select
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              aria-label="Filter by Campaign"
              className="px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-md bg-white text-slate-800 focus:outline-none focus:border-teal-700"
            >
              <option value="all">All Campaigns</option>
              {data?.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            disabled={!data}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        </div>

        {/* Main Viewport */}
        <main className="flex-1 p-6 max-w-[1380px] w-full mx-auto">
          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center justify-between gap-4 text-sm text-red-800">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => fetchOverview({ force: true })}
                className="px-3 py-1 text-xs font-medium bg-white border border-red-200 rounded hover:bg-red-100 cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {loading && !data ? (
            <div className="space-y-6 animate-pulse">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                {[1, 2, 3, 4].map((n) => (
                  <div key={n} className="h-24 bg-white border border-slate-200 rounded-lg" />
                ))}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 h-80 bg-white border border-slate-200 rounded-lg" />
                <div className="lg:col-span-4 h-80 bg-white border border-slate-200 rounded-lg" />
              </div>
            </div>
          ) : data ? (
            <>
              {activeTab === 'overview' && (
                <OverviewView
                  data={data}
                  onSelectAccount={(id) => {
                    setAccountId(id);
                    setActiveTab('users');
                  }}
                  onNavigate={(tab) => setActiveTab(tab)}
                  onTriggerTestWebhook={() => handleTriggerTestWebhook('campaign_reply')}
                  testingWebhook={testingWebhook}
                />
              )}

              {activeTab === 'users' && <UserPerformanceView data={data} />}

              {activeTab === 'campaigns' && (
                <CampaignsTemplatesView
                  data={data}
                  onToggleCampaignState={handleToggleCampaignState}
                />
              )}

              {activeTab === 'leads' && <LeadsConversationsView data={data} />}

              {activeTab === 'webhooks' && (
                <WebhooksVueView
                  data={data}
                  onRefresh={() => fetchOverview({ force: true, silent: true })}
                  onTriggerTestWebhook={handleTriggerTestWebhook}
                  testingWebhook={testingWebhook}
                />
              )}
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
