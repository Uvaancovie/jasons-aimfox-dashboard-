import { useEffect, useState } from 'react';
import type { AimfoxCampaign, CampaignsPageResponse } from '../types/aimfox';
import { useCachedPage } from '../lib/swrCache';
import { Pause, Play } from 'lucide-react';

interface CampaignsPageProps {
  campaignIdFilter: string;
  syncEpoch: number;
  onMetaUpdate: (meta: CampaignsPageResponse) => void;
}

export function CampaignsPage({
  campaignIdFilter,
  syncEpoch,
  onMetaUpdate,
}: CampaignsPageProps) {
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<'ALL' | 'ACTIVE' | 'PAUSED'>('ALL');
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, refresh, mutate } = useCachedPage<CampaignsPageResponse>(
    '/api/pages/campaigns',
  );

  useEffect(() => {
    if (data) onMetaUpdate(data);
  }, [data, onMetaUpdate]);

  useEffect(() => {
    if (syncEpoch > 0) {
      refresh({ force: true });
    }
  }, [syncEpoch, refresh]);

  const handleToggle = async (campaign: AimfoxCampaign) => {
    const nextState = campaign.state === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setUpdatingId(campaign.id);
    setActionError(null);

    // Optimistic update
    mutate((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        campaigns: prev.campaigns.map((c) =>
          c.id === campaign.id ? { ...c, state: nextState } : c,
        ),
      };
    });

    try {
      const res = await fetch(`/api/aimfox/campaigns/${encodeURIComponent(campaign.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: nextState }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error || 'Failed to update campaign state');
      }
      await refresh({ force: true, silent: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update campaign');
      await refresh({ force: true, silent: true });
    } finally {
      setUpdatingId(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-64 bg-white border border-slate-200 rounded-lg" />
        <div className="h-64 bg-white border border-slate-200 rounded-lg" />
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

  const filteredCampaigns = data.campaigns.filter((c) => {
    if (campaignIdFilter !== 'all' && c.id !== campaignIdFilter) return false;
    if (stateFilter === 'ALL') return true;
    return c.state === stateFilter;
  });

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-800">
          {actionError}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Campaign Control & Throughput
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Live Aimfox sequences with direct Pause / Resume execution
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(['ALL', 'ACTIVE', 'PAUSED'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setStateFilter(tab)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  stateFilter === tab
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab === 'ALL' ? 'All' : tab === 'ACTIVE' ? 'Active' : 'Paused'}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-medium text-slate-500">
                <th className="py-2.5 px-5">Campaign Name</th>
                <th className="py-2.5 px-3">State</th>
                <th className="py-2.5 px-3 text-right">Targets</th>
                <th className="py-2.5 px-3 text-right">Progress</th>
                <th className="py-2.5 px-3 text-right">Views</th>
                <th className="py-2.5 px-3 text-right">Connects</th>
                <th className="py-2.5 px-3 text-right">Accepted</th>
                <th className="py-2.5 px-3 text-right">Messages</th>
                <th className="py-2.5 px-3 text-right">Replies</th>
                <th className="py-2.5 px-5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredCampaigns.map((c) => {
                const m = c.metrics;
                const acceptPct =
                  m && m.sent_connections > 0
                    ? ((m.accepted_connections / m.sent_connections) * 100).toFixed(1)
                    : '0.0';
                const replyPct =
                  m && m.sent_messages > 0
                    ? ((m.replies / m.sent_messages) * 100).toFixed(1)
                    : '0.0';
                const compPct = Math.round((c.completion || 0) * 100);
                const isActive = c.state === 'ACTIVE';

                return (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="py-3.5 px-5">
                      <div className="font-medium text-slate-900">{c.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        Outreach: {c.outreach_type} · Created{' '}
                        {new Date(c.created_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </div>
                    </td>
                    <td className="py-3.5 px-3 text-xs font-medium">
                      <span className={isActive ? 'text-emerald-700' : 'text-amber-700'}>
                        {isActive ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700">
                      {c.target_count.toLocaleString()}
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700">
                      {compPct}%
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700">
                      {(m?.views ?? 0).toLocaleString()}
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-900">
                      {(m?.sent_connections ?? 0).toLocaleString()}
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-emerald-700">
                      {m?.accepted_connections ?? 0} ({acceptPct}%)
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-900">
                      {(m?.sent_messages ?? 0).toLocaleString()}
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-amber-700 font-semibold">
                      {m?.replies ?? 0} ({replyPct}%)
                    </td>
                    <td className="py-3.5 px-5 text-right">
                      <button
                        type="button"
                        disabled={updatingId === c.id}
                        onClick={() => handleToggle(c)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        {isActive ? (
                          <>
                            <Pause className="w-3.5 h-3.5" />
                            <span>Pause</span>
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5" />
                            <span>Resume</span>
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filteredCampaigns.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-sm text-slate-500">
                    No campaigns match the selected filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">
            Message Template Conversion Rates ({data.templates.length})
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Direct Aimfox template response ratios ranked by outbound volume
          </p>
        </div>

        <div className="divide-y divide-slate-100">
          {data.templates.map((tpl) => {
            const replyRate =
              tpl.metrics.sent > 0
                ? ((tpl.metrics.replies / tpl.metrics.sent) * 100).toFixed(1)
                : '0.0';

            return (
              <div key={tpl.id} className="p-5 grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                <div className="lg:col-span-8 min-w-0">
                  <div className="flex items-center gap-2 text-xs text-slate-500 mb-1.5">
                    <span className="font-semibold text-slate-900">Template #{tpl.name}</span>
                    <span aria-hidden="true">·</span>
                    <span>{tpl.type.replace('_', ' ')}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      Created {new Date(tpl.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm text-slate-700 whitespace-pre-line leading-relaxed">
                    {tpl.message}
                  </p>
                </div>

                <div className="lg:col-span-4 grid grid-cols-3 gap-3 font-mono tabular-nums lg:text-right">
                  <div>
                    <div className="text-[11px] text-slate-500">Sent</div>
                    <div className="text-base font-semibold text-slate-900 mt-0.5">
                      {tpl.metrics.sent}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Replies</div>
                    <div className="text-base font-semibold text-teal-700 mt-0.5">
                      {tpl.metrics.replies}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Reply Rate</div>
                    <div className="text-base font-semibold text-emerald-700 mt-0.5">
                      {replyRate}%
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
