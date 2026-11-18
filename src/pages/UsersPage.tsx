import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { TimeRange, UsersPageResponse } from '../types/aimfox';
import { Avatar } from '../components/Avatar';
import { OutreachChart } from '../components/OutreachChart';
import { useCachedPage } from '../lib/swrCache';

interface UsersPageProps {
  range: TimeRange;
  syncEpoch: number;
  onMetaUpdate: (meta: UsersPageResponse) => void;
}

export function UsersPage({ range, syncEpoch, onMetaUpdate }: UsersPageProps) {
  const { accountId: routeAccountId } = useParams<{ accountId?: string }>();
  const navigate = useNavigate();

  const url = `/api/pages/users?range=${range}`;
  const { data, loading, error, refresh } = useCachedPage<UsersPageResponse>(url);

  useEffect(() => {
    if (data) onMetaUpdate(data);
  }, [data, onMetaUpdate]);

  useEffect(() => {
    if (syncEpoch > 0) {
      refresh({ force: true });
    }
  }, [syncEpoch, refresh]);

  if (loading && !data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-24 bg-white border border-slate-200 rounded-lg" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-32 bg-white border border-slate-200 rounded-lg" />
          ))}
        </div>
        <div className="h-72 bg-white border border-slate-200 rounded-lg" />
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

  const { userPerformance, campaigns } = data;
  const selectedUser =
    userPerformance.find((u) => u.account.id === routeAccountId) || userPerformance[0];
  const rangeLabel = range === '7d' ? 'Last 7 Days' : range === '90d' ? 'Last 90 Days' : 'Last 30 Days';

  if (!selectedUser) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-8 text-center text-sm text-slate-500">
        No connected LinkedIn seats found in Aimfox workspace.
      </div>
    );
  }

  const ownedCampaigns = campaigns.filter((c) =>
    c.owners?.includes(selectedUser.account.id),
  );
  const connectQuotaPct = Math.min(
    100,
    Math.round((selectedUser.todayConnections / Math.max(selectedUser.dailyConnectLimit, 1)) * 100),
  );
  const inmailToday =
    selectedUser.buckets[selectedUser.buckets.length - 1]?.sent_inmails || 0;
  const inmailQuotaPct = Math.min(
    100,
    Math.round((inmailToday / Math.max(selectedUser.dailyInmailLimit, 1)) * 100),
  );

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <Avatar
            src={selectedUser.account.picture_url}
            name={selectedUser.account.full_name}
            size="lg"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900">
                {selectedUser.account.full_name}
              </h2>
              <span className="text-xs text-slate-400">·</span>
              <span
                className={`text-xs font-medium ${
                  selectedUser.account.state === 'LoggedIn'
                    ? 'text-emerald-700'
                    : 'text-amber-700'
                }`}
              >
                {selectedUser.account.state === 'LoggedIn'
                  ? 'LinkedIn Session Active'
                  : selectedUser.account.state}
              </span>
              <span className="text-xs text-slate-400">·</span>
              <span className="text-xs font-mono text-slate-500">
                ID {selectedUser.account.id}
              </span>
            </div>
            <p className="text-xs text-slate-600 mt-1 truncate max-w-2xl">
              {selectedUser.account.occupation}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {userPerformance.map((row) => (
            <button
              key={row.account.id}
              type="button"
              onClick={() => navigate(`/users/${row.account.id}`)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                row.account.id === selectedUser.account.id
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {row.account.full_name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">
            Daily Connection Quota Usage
          </div>
          <div className="mt-2 flex items-baseline justify-between font-mono tabular-nums">
            <span className="text-2xl font-semibold text-slate-900">
              {selectedUser.todayConnections}
            </span>
            <span className="text-xs text-slate-500">
              / {selectedUser.dailyConnectLimit} daily limit ({connectQuotaPct}%)
            </span>
          </div>
          <div className="mt-3 h-2 w-full bg-slate-100 rounded-sm overflow-hidden">
            <div className="h-full bg-teal-700 transition-all" style={{ width: `${connectQuotaPct}%` }} />
          </div>
          <div className="mt-3 text-xs text-slate-500 font-mono tabular-nums">
            Warmup mode: {selectedUser.account.limits?.warmup?.enabled ? 'Enabled' : 'Off'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">
            Daily InMail Quota & Volume
          </div>
          <div className="mt-2 flex items-baseline justify-between font-mono tabular-nums">
            <span className="text-2xl font-semibold text-slate-900">{inmailToday}</span>
            <span className="text-xs text-slate-500">
              / {selectedUser.dailyInmailLimit} daily limit ({inmailQuotaPct}%)
            </span>
          </div>
          <div className="mt-3 h-2 w-full bg-slate-100 rounded-sm overflow-hidden">
            <div className="h-full bg-slate-800 transition-all" style={{ width: `${inmailQuotaPct}%` }} />
          </div>
          <div className="mt-3 text-xs text-slate-500 font-mono tabular-nums">
            Window total: {selectedUser.totals.sent_inmails} InMails · {selectedUser.totals.inmail_replies} replies
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">
            Conversion Efficiency ({rangeLabel})
          </div>
          <div className="mt-2 grid grid-cols-2 gap-4 font-mono tabular-nums">
            <div>
              <div className="text-2xl font-semibold text-emerald-700">
                {selectedUser.acceptanceRate}%
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">Acceptance rate</div>
            </div>
            <div>
              <div className="text-2xl font-semibold text-amber-700">
                {selectedUser.replyRate}%
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">Reply rate</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-slate-500 font-mono tabular-nums">
            {selectedUser.totals.sent_likes} post likes · {selectedUser.totals.sent_endorsements} endorsements
          </div>
        </div>
      </div>

      <OutreachChart
        buckets={selectedUser.buckets}
        rangeLabel={`${selectedUser.account.full_name} · ${rangeLabel}`}
      />

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h3 className="text-base font-semibold text-slate-900">
            Assigned Campaigns ({ownedCampaigns.length})
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Lifetime throughput attributed to {selectedUser.account.full_name}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-medium text-slate-500">
                <th className="py-2.5 px-5">Campaign</th>
                <th className="py-2.5 px-3">State</th>
                <th className="py-2.5 px-3 text-right">Targets</th>
                <th className="py-2.5 px-3 text-right">Completion</th>
                <th className="py-2.5 px-3 text-right">Connects</th>
                <th className="py-2.5 px-3 text-right">Accepted</th>
                <th className="py-2.5 px-5 text-right">Replies</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {ownedCampaigns.map((c) => {
                const m = c.metrics;
                const compPct = Math.round((c.completion || 0) * 100);
                return (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="py-3 px-5 font-medium text-slate-900">{c.name}</td>
                    <td className="py-3 px-3 text-xs font-medium">
                      <span className={c.state === 'ACTIVE' ? 'text-emerald-700' : 'text-amber-700'}>
                        {c.state === 'ACTIVE' ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                      {c.target_count.toLocaleString()}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                      {compPct}%
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                      {m?.sent_connections ?? 0}
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-emerald-700">
                      {m?.accepted_connections ?? 0}
                    </td>
                    <td className="py-3 px-5 text-right font-mono tabular-nums text-amber-700 font-semibold">
                      {m?.replies ?? 0}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
