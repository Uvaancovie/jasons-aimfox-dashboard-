import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  OverviewPageResponse,
  StoredWebhookEvent,
  TimeRange,
} from '../types/aimfox';
import { Avatar } from '../components/Avatar';
import { ConversionFunnel } from '../components/ConversionFunnel';
import { OutreachChart } from '../components/OutreachChart';
import { useCachedPage } from '../lib/swrCache';
import { ArrowUpRight, Send } from 'lucide-react';

interface OverviewPageProps {
  range: TimeRange;
  accountId: string;
  campaignId: string;
  latestWebhook: StoredWebhookEvent | null;
  syncEpoch: number;
  onMetaUpdate: (meta: OverviewPageResponse) => void;
}

function formatTimeAgo(isoOrDate: string | number): string {
  const ts = typeof isoOrDate === 'number' ? isoOrDate : new Date(isoOrDate).getTime();
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function describeWebhookEvent(evt: StoredWebhookEvent): string {
  const payload = evt.event || {};
  const lead = String(payload.lead_name || payload.full_name || 'Prospect');
  const campaign = String(payload.campaign_name || 'Workspace');
  return `${lead} · ${campaign}`;
}

export function OverviewPage({
  range,
  accountId,
  campaignId,
  latestWebhook,
  syncEpoch,
  onMetaUpdate,
}: OverviewPageProps) {
  const navigate = useNavigate();
  const [testingWebhook, setTestingWebhook] = useState(false);

  const url = `/api/pages/overview?range=${range}&accountId=${encodeURIComponent(accountId)}&campaignId=${encodeURIComponent(campaignId)}`;
  const { data, loading, error, refresh, mutate } = useCachedPage<OverviewPageResponse>(url);

  useEffect(() => {
    if (data) onMetaUpdate(data);
  }, [data, onMetaUpdate]);

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

  const handleTriggerTestWebhook = async () => {
    setTestingWebhook(true);
    try {
      const res = await fetch('/api/webhooks/aimfox/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: 'campaign_reply' }),
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

  if (loading && !data) {
    return (
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

  const { totals, buckets, userPerformance, recentLeads, webhookEvents } = data;
  const rangeLabel = range === '7d' ? 'Last 7 Days' : range === '90d' ? 'Last 90 Days' : 'Last 30 Days';

  const kpis = [
    {
      label: 'Connections Sent',
      value: totals.sent_connections.toLocaleString(),
      sub: `${totals.accepted_connections.toLocaleString()} accepted · ${totals.acceptanceRate}% rate`,
      accent: 'text-slate-900',
    },
    {
      label: 'Acceptance Rate',
      value: `${totals.acceptanceRate}%`,
      sub: `${totals.views.toLocaleString()} profile views in window`,
      accent: 'text-emerald-700',
    },
    {
      label: 'Follow-up Replies',
      value: totals.replies.toLocaleString(),
      sub: `${totals.sent_messages.toLocaleString()} messages · ${totals.replyRate}% reply rate`,
      accent: 'text-teal-700',
    },
    {
      label: 'Active Pipeline Targets',
      value: totals.totalTargets.toLocaleString(),
      sub: `${data.campaigns.filter((c) => c.state === 'ACTIVE').length} active campaigns · ${totals.unreadConversations} unread`,
      accent: 'text-slate-900',
    },
  ];

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-xs text-amber-800">
          Showing cached metrics ({error})
        </div>
      )}

      {/* 4-column KPI strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="bg-white border border-slate-200 rounded-lg px-5 py-4">
            <div className="text-xs font-medium text-slate-500">{kpi.label}</div>
            <div className={`mt-2 text-2xl font-semibold font-mono tabular-nums ${kpi.accent}`}>
              {kpi.value}
            </div>
            <div className="mt-1.5 text-xs text-slate-500 font-mono tabular-nums truncate">
              {kpi.sub}
            </div>
          </div>
        ))}
      </section>

      {/* Primary chart + Conversion funnel */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-8">
          <OutreachChart buckets={buckets} rangeLabel={rangeLabel} />
        </div>
        <div className="lg:col-span-4">
          <ConversionFunnel totals={totals} />
        </div>
      </section>

      {/* User Performance Table + Real-Time Event Stream */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">User-Specific Performance</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Per-seat LinkedIn outreach quota and conversion efficiency
              </p>
            </div>
            <Link
              to="/users"
              className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap shrink-0"
            >
              <span>Detailed Seat View</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-medium text-slate-500">
                  <th className="py-2.5 px-5">LinkedIn Account</th>
                  <th className="py-2.5 px-3 text-right">Today Quota</th>
                  <th className="py-2.5 px-3 text-right">Connects</th>
                  <th className="py-2.5 px-3 text-right">Accept %</th>
                  <th className="py-2.5 px-3 text-right">Messages</th>
                  <th className="py-2.5 px-5 text-right">Replies</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {userPerformance.map((row) => {
                  const isOnline = row.account.state === 'LoggedIn';
                  return (
                    <tr
                      key={row.account.id}
                      onClick={() => navigate(`/users/${row.account.id}`)}
                      className="hover:bg-slate-50 transition-colors cursor-pointer"
                    >
                      <td className="py-3 px-5">
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar src={row.account.picture_url} name={row.account.full_name} />
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900 truncate">
                              {row.account.full_name}
                            </div>
                            <div className="text-xs text-slate-500 truncate">
                              <span
                                className={
                                  isOnline
                                    ? 'text-emerald-700 font-medium'
                                    : 'text-amber-700 font-medium'
                                }
                              >
                                {isOnline ? 'Connected' : row.account.state}
                              </span>
                              <span aria-hidden="true"> · </span>
                              <span>{row.activeCampaignsCount} active campaigns</span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-xs tabular-nums text-slate-700 whitespace-nowrap">
                        {row.todayConnections}/{row.dailyConnectLimit}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                        {row.totals.sent_connections}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-emerald-700 font-medium">
                        {row.acceptanceRate}%
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                        {row.totals.sent_messages}
                      </td>
                      <td className="py-3 px-5 text-right font-mono tabular-nums text-amber-700 font-semibold">
                        {row.totals.replies} ({row.replyRate}%)
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Live Webhook & Recent Transitions */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg flex flex-col">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Real-Time Event Stream</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Live webhook callbacks & recent Aimfox lead transitions
              </p>
            </div>
            <button
              type="button"
              onClick={handleTriggerTestWebhook}
              disabled={testingWebhook}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{testingWebhook ? 'Sending...' : 'Test Webhook'}</span>
            </button>
          </div>

          <div className="divide-y divide-slate-100 flex-1 overflow-y-auto max-h-[340px]">
            {webhookEvents.slice(0, 5).map((evt) => (
              <div key={evt.id} className="px-5 py-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-900 flex items-center gap-2">
                    <span className="font-mono text-teal-700">{evt.event_type}</span>
                    {evt.is_test && <span className="text-slate-400">· Test payload</span>}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5 truncate">
                    {describeWebhookEvent(evt)}
                  </div>
                </div>
                <span className="text-[11px] font-mono tabular-nums text-slate-400 whitespace-nowrap shrink-0">
                  {formatTimeAgo(evt.received_at)}
                </span>
              </div>
            ))}

            {recentLeads.slice(0, 6).map((lead) => (
              <div
                key={`${lead.target_id}-${lead.timestamp}`}
                className="px-5 py-3 flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar src={lead.target.picture_url} name={lead.target.full_name} size="sm" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-slate-900 truncate">
                      {lead.target.full_name}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      <span className="text-emerald-700 font-medium capitalize">
                        {lead.transition}
                      </span>
                      <span aria-hidden="true"> · </span>
                      <span>{lead.campaign_name}</span>
                    </div>
                  </div>
                </div>
                <span className="text-[11px] font-mono tabular-nums text-slate-400 whitespace-nowrap shrink-0">
                  {formatTimeAgo(lead.timestamp)}
                </span>
              </div>
            ))}

            {webhookEvents.length === 0 && recentLeads.length === 0 && (
              <div className="px-5 py-10 text-center text-sm text-slate-500">
                Waiting for Aimfox webhook deliveries or lead transitions.
              </div>
            )}
          </div>

          <div className="px-5 py-2.5 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between text-xs">
            <span className="text-slate-500 font-mono tabular-nums">
              {webhookEvents.length} webhook events stored
            </span>
            <Link to="/webhooks" className="font-medium text-teal-700 hover:text-teal-800">
              Configure Webhooks
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
