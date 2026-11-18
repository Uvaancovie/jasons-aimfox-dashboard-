import { useCallback, useEffect, useState } from 'react';
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import type {
  BasePageResponse,
  StoredWebhookEvent,
  TimeRange,
} from './types/aimfox';
import { clearAllClientCache } from './lib/swrCache';
import { OverviewPage } from './pages/OverviewPage';
import { UsersPage } from './pages/UsersPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { LeadsPage } from './pages/LeadsPage';
import { WebhooksPage } from './pages/WebhooksPage';
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

const NAV_ITEMS = [
  { to: '/overview', label: 'Overview', icon: BarChart3 },
  { to: '/users', label: 'User Performance', icon: Users },
  { to: '/campaigns', label: 'Campaigns', icon: Layers },
  { to: '/leads', label: 'Leads & Inbox', icon: Activity },
  { to: '/webhooks', label: 'Webhooks & Vue', icon: Webhook },
];

function DashboardShell() {
  const location = useLocation();
  const navigate = useNavigate();

  const [range, setRange] = useState<TimeRange>('30d');
  const [accountId, setAccountId] = useState<string>('all');
  const [campaignId, setCampaignId] = useState<string>('all');
  const [meta, setMeta] = useState<BasePageResponse | null>(null);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [syncEpoch, setSyncEpoch] = useState<number>(0);
  const [latestWebhook, setLatestWebhook] = useState<StoredWebhookEvent | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'polling' | 'reconnecting'>('connecting');
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);

  const handleMetaUpdate = useCallback((nextMeta: BasePageResponse) => {
    setMeta(nextMeta);
  }, []);

  // Real-time stream: WebSocket on Node server, clean 10s polling on serverless (Vercel)
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
          if (Array.isArray(json.events) && json.events[0]) {
            setLatestWebhook(json.events[0]);
          }
        } catch {
          // ignore transient poll errors
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
            setLatestWebhook(msg.payload as StoredWebhookEvent);
          } else if (
            msg.type === 'dashboard:synced' ||
            msg.type === 'campaign:updated' ||
            msg.type === 'webhooks:changed'
          ) {
            clearAllClientCache();
            setSyncEpoch((n) => n + 1);
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
  }, []);

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      await fetch('/api/dashboard/sync', { method: 'POST' });
      clearAllClientCache();
      setSyncEpoch((n) => n + 1);
    } finally {
      setTimeout(() => setSyncing(false), 350);
    }
  };

  const handleExportCsv = () => {
    const params = new URLSearchParams({ range, accountId, campaignId });
    window.location.href = `/api/export/csv?${params.toString()}`;
  };

  const currentPath = location.pathname;
  const currentTabLabel =
    NAV_ITEMS.find((item) => currentPath.startsWith(item.to))?.label || 'Overview';

  const showRangeFilter =
    currentPath.startsWith('/overview') || currentPath.startsWith('/users');
  const showAccountFilter =
    currentPath.startsWith('/overview') ||
    currentPath.startsWith('/users') ||
    currentPath.startsWith('/leads');
  const showCampaignFilter =
    currentPath.startsWith('/overview') ||
    currentPath.startsWith('/campaigns') ||
    currentPath.startsWith('/leads');

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
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
              {meta?.customer.workspaceName || 'Baby George Creative'}
            </div>
            <div className="text-xs text-slate-500 truncate mt-0.5">
              {meta?.customer.fullName || 'Jason Thompson'}
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              {meta?.customer.email || 'jason@aurorasalesagency.com'}
            </div>
          </div>

          <nav className="p-3 space-y-1" aria-label="Dashboard sections">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileMenuOpen(false)}
                  className={({ isActive }) =>
                    `w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                      isActive
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                    }`
                  }
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </nav>
        </div>

        {/* Real Telemetry & Cache Token Savings Footer */}
        <div className="p-4 border-t border-slate-200 space-y-2 text-xs">
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
              {meta?.cache.requestsLastMinute ?? 0}/{meta?.cache.limitPerMinute ?? 60} rpm
            </span>
          </div>
          <div className="flex items-center justify-between font-mono tabular-nums text-emerald-700">
            <span>Tokens Saved</span>
            <span>{meta?.cache.tokensSavedEstimate ?? 0} cached</span>
          </div>
          {meta?.syncedAt && (
            <div className="text-[11px] font-mono tabular-nums text-slate-400">
              {meta.cache.hit ? 'Cached' : 'Fresh'} · {new Date(meta.syncedAt).toLocaleTimeString()}
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
                {meta?.customer.workspaceName || 'Baby George Creative'}
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
            {showRangeFilter && (
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
            )}

            {showAccountFilter && (
              <select
                value={accountId}
                onChange={(e) => {
                  const val = e.target.value;
                  setAccountId(val);
                  if (currentPath.startsWith('/users') && val !== 'all') {
                    navigate(`/users/${val}`);
                  } else if (currentPath.startsWith('/users') && val === 'all') {
                    navigate('/users');
                  }
                }}
                aria-label="Filter by LinkedIn account"
                className="px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-md bg-white text-slate-800 focus:outline-none focus:border-teal-700"
              >
                <option value="all">All LinkedIn Seats</option>
                {meta?.accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.full_name}
                  </option>
                ))}
              </select>
            )}

            {showCampaignFilter && (
              <select
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                aria-label="Filter by Campaign"
                className="px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-md bg-white text-slate-800 focus:outline-none focus:border-teal-700"
              >
                <option value="all">All Campaigns</option>
                {meta?.campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        </div>

        {/* Route Viewport */}
        <main className="flex-1 p-6 max-w-[1380px] w-full mx-auto">
          <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route
              path="/overview"
              element={
                <OverviewPage
                  range={range}
                  accountId={accountId}
                  campaignId={campaignId}
                  latestWebhook={latestWebhook}
                  syncEpoch={syncEpoch}
                  onMetaUpdate={handleMetaUpdate}
                />
              }
            />
            <Route
              path="/users"
              element={
                <UsersPage
                  range={range}
                  syncEpoch={syncEpoch}
                  onMetaUpdate={handleMetaUpdate}
                />
              }
            />
            <Route
              path="/users/:accountId"
              element={
                <UsersPage
                  range={range}
                  syncEpoch={syncEpoch}
                  onMetaUpdate={handleMetaUpdate}
                />
              }
            />
            <Route
              path="/campaigns"
              element={
                <CampaignsPage
                  campaignIdFilter={campaignId}
                  syncEpoch={syncEpoch}
                  onMetaUpdate={handleMetaUpdate}
                />
              }
            />
            <Route
              path="/leads"
              element={
                <LeadsPage
                  accountIdFilter={accountId}
                  campaignIdFilter={campaignId}
                  syncEpoch={syncEpoch}
                  onMetaUpdate={handleMetaUpdate}
                />
              }
            />
            <Route
              path="/webhooks"
              element={
                <WebhooksPage
                  latestWebhook={latestWebhook}
                  syncEpoch={syncEpoch}
                  onMetaUpdate={handleMetaUpdate}
                />
              }
            />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <DashboardShell />
    </BrowserRouter>
  );
}
