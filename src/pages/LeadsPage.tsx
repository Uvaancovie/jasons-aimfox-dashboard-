import { useEffect, useState } from 'react';
import type { AimfoxLead, LeadsPageResponse } from '../types/aimfox';
import { Avatar } from '../components/Avatar';
import { useCachedPage } from '../lib/swrCache';
import { Search } from 'lucide-react';

interface LeadsPageProps {
  accountIdFilter: string;
  campaignIdFilter: string;
  syncEpoch: number;
  onMetaUpdate: (meta: LeadsPageResponse) => void;
}

export function LeadsPage({
  accountIdFilter,
  campaignIdFilter,
  syncEpoch,
  onMetaUpdate,
}: LeadsPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<AimfoxLead[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedConvUrn, setSelectedConvUrn] = useState<string>('');

  const { data, loading, error, refresh } = useCachedPage<LeadsPageResponse>('/api/pages/leads');

  useEffect(() => {
    if (data) {
      onMetaUpdate(data);
      if (!selectedConvUrn && data.conversations[0]?.conversation_urn) {
        setSelectedConvUrn(data.conversations[0].conversation_urn);
      }
    }
  }, [data, onMetaUpdate, selectedConvUrn]);

  useEffect(() => {
    if (syncEpoch > 0) {
      refresh({ force: true });
    }
  }, [syncEpoch, refresh]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch('/api/aimfox/leads/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery, count: 20 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Search failed');
      setSearchResults(json.leads || []);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Failed to search leads');
    } finally {
      setSearching(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-64 bg-white border border-slate-200 rounded-lg" />
        <div className="h-80 bg-white border border-slate-200 rounded-lg" />
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

  const filteredRecentLeads = data.recentLeads.filter((lead) => {
    if (
      accountIdFilter !== 'all' &&
      lead.account_id !== accountIdFilter &&
      lead.owner !== accountIdFilter
    ) {
      return false;
    }
    if (campaignIdFilter !== 'all' && lead.campaign_id !== campaignIdFilter) return false;
    return true;
  });

  const selectedConversation =
    data.conversations.find((c) => c.conversation_urn === selectedConvUrn) ||
    data.conversations[0];

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Lead Directory & Search</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Query Aimfox prospects across Baby George Creative target lists
            </p>
          </div>
          <form onSubmit={handleSearch} className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search name, role, or company..."
                className="pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-md bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700 w-64"
              />
            </div>
            <button
              type="submit"
              disabled={searching}
              className="px-4 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {searching ? 'Searching...' : 'Search Leads'}
            </button>
            {searchResults !== null && (
              <button
                type="button"
                onClick={() => {
                  setSearchResults(null);
                  setSearchQuery('');
                }}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                Reset
              </button>
            )}
          </form>
        </div>

        {searchError && (
          <div className="px-5 py-3 text-xs text-red-700 bg-red-50 border-b border-red-100">
            {searchError}
          </div>
        )}

        {searchResults !== null ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-medium text-slate-500">
                  <th className="py-2.5 px-5">Lead</th>
                  <th className="py-2.5 px-3">Location</th>
                  <th className="py-2.5 px-3">Source List</th>
                  <th className="py-2.5 px-5 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {searchResults.map((lead) => (
                  <tr key={lead.id} className="hover:bg-slate-50">
                    <td className="py-3 px-5">
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar src={lead.picture_url} name={lead.full_name} size="sm" />
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 truncate">{lead.full_name}</div>
                          <div className="text-xs text-slate-500 truncate max-w-md">
                            {lead.occupation || 'LinkedIn Member'}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-600">
                      {lead.location?.name || '—'}
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-600">
                      {lead.origins?.[0]?.name || '—'}
                    </td>
                    <td className="py-3 px-5 text-right text-xs font-medium">
                      <span className={lead.replied ? 'text-emerald-700' : 'text-slate-500'}>
                        {lead.replied ? 'Replied' : 'In Sequence'}
                      </span>
                    </td>
                  </tr>
                ))}
                {searchResults.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-sm text-slate-500">
                      No matching leads returned by Aimfox.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-medium text-slate-500">
                  <th className="py-2.5 px-5">Recent Lead Transition</th>
                  <th className="py-2.5 px-3">Campaign</th>
                  <th className="py-2.5 px-3">Transition</th>
                  <th className="py-2.5 px-5 text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredRecentLeads.map((lead) => (
                  <tr key={`${lead.target_id}-${lead.timestamp}`} className="hover:bg-slate-50">
                    <td className="py-3 px-5">
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar src={lead.target.picture_url} name={lead.target.full_name} size="sm" />
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 truncate">
                            {lead.target.full_name}
                          </div>
                          <div className="text-xs text-slate-500 truncate max-w-md">
                            {lead.target.occupation || 'LinkedIn Profile'}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-700">{lead.campaign_name}</td>
                    <td className="py-3 px-3 text-xs font-medium text-emerald-700 capitalize">
                      {lead.transition}
                    </td>
                    <td className="py-3 px-5 text-right font-mono text-xs tabular-nums text-slate-500">
                      {new Date(lead.timestamp).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden grid grid-cols-1 lg:grid-cols-12 min-h-[380px]">
        <div className="lg:col-span-5 border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col">
          <div className="px-5 py-4 border-b border-slate-200">
            <h3 className="text-base font-semibold text-slate-900">
              LinkedIn Inbox ({data.conversations.length})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">Recent automated and manual threads</p>
          </div>
          <div className="divide-y divide-slate-100 overflow-y-auto max-h-[380px]">
            {data.conversations.map((conv) => {
              const participant = conv.participants?.[0];
              const isSelected = conv.conversation_urn === selectedConversation?.conversation_urn;
              return (
                <button
                  key={conv.conversation_urn}
                  type="button"
                  onClick={() => setSelectedConvUrn(conv.conversation_urn)}
                  className={`w-full text-left px-5 py-3.5 flex items-start gap-3 transition-colors cursor-pointer ${
                    isSelected ? 'bg-slate-50' : 'hover:bg-slate-50/70'
                  }`}
                >
                  <Avatar
                    src={participant?.picture_url}
                    name={participant?.full_name || 'Lead'}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900 truncate">
                        {participant?.full_name || 'LinkedIn Contact'}
                      </span>
                      <span className="text-[11px] font-mono tabular-nums text-slate-400 shrink-0">
                        {new Date(conv.last_activity_at).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 truncate mt-1">
                      {conv.last_message?.body || 'No message body'}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-7 flex flex-col">
          {selectedConversation ? (
            <>
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar
                    src={selectedConversation.participants?.[0]?.picture_url}
                    name={selectedConversation.participants?.[0]?.full_name || 'Lead'}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 truncate">
                      {selectedConversation.participants?.[0]?.full_name || 'LinkedIn Contact'}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {selectedConversation.participants?.[0]?.occupation || 'Connected Prospect'}
                    </div>
                  </div>
                </div>
                <div className="text-xs font-mono text-slate-500 shrink-0">
                  {selectedConversation.connected ? '1st Connection' : 'Pending'}
                </div>
              </div>
              <div className="p-6 flex-1 bg-slate-50/40">
                <div className="bg-white border border-slate-200 rounded-lg p-4 max-w-2xl">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                    <span className="font-medium text-slate-700">Latest Message</span>
                    <span className="font-mono tabular-nums">
                      {selectedConversation.last_message?.created_at
                        ? new Date(selectedConversation.last_message.created_at).toLocaleString()
                        : ''}
                    </span>
                  </div>
                  <p className="text-sm text-slate-800 whitespace-pre-line leading-relaxed">
                    {selectedConversation.last_message?.body || 'No message content available.'}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center p-8 text-sm text-slate-500">
              Select a conversation thread to inspect the latest message.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
