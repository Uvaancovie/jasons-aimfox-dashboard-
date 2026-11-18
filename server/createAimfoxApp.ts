import express from 'express';
import type { Express, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  AimfoxAccount,
  AimfoxAccountLimits,
  AimfoxCampaign,
  AimfoxConversation,
  AimfoxTemplate,
  AimfoxWebhookConfig,
  CampaignMetrics,
  DashboardOverviewResponse,
  InteractionBucket,
  RecentLeadEvent,
  StoredWebhookEvent,
  TimeRange,
  UserPerformanceRow,
} from '../src/types/aimfox.ts';

const AIMFOX_BASE_URL = 'https://api.aimfox.com';
const CACHE_TTL_MS = 45_000;
const RATE_LIMIT_PER_MIN = 60;

interface PersistedStore {
  webhookEvents: StoredWebhookEvent[];
}

export interface AimfoxAppOptions {
  wsSupported: boolean;
  onBroadcast?: (type: string, payload: unknown) => void;
  getWsClientCount?: () => number;
}

function getStorePath(): string {
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), 'aurora-pulse-store.json');
  }
  const localDir = path.resolve(process.cwd(), '.data');
  try {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    fs.accessSync(localDir, fs.constants.W_OK);
    return path.join(localDir, 'store.json');
  } catch {
    return path.join(os.tmpdir(), 'aurora-pulse-store.json');
  }
}

function loadStore(): PersistedStore {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    return { webhookEvents: [] };
  }
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedStore>;
    return {
      webhookEvents: Array.isArray(parsed.webhookEvents) ? parsed.webhookEvents : [],
    };
  } catch {
    return { webhookEvents: [] };
  }
}

function saveStore(store: PersistedStore): void {
  const storePath = getStorePath();
  try {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // Ignore write failures in ephemeral read-only environments
  }
}

function getWebhookSecret(): string | null {
  const secret = process.env.AIMFOX_WEBHOOK_SECRET?.trim();
  if (!secret || secret === 'MY_AIMFOX_WEBHOOK_SECRET') {
    return null;
  }
  return secret;
}

function getAimfoxApiKey(): string | null {
  const key = process.env.AIMFOX_API_KEY?.trim();
  if (!key || key === 'MY_AIMFOX_API_KEY') {
    return null;
  }
  return key;
}

export function createAimfoxApp(options: AimfoxAppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const persistedStore = loadStore();
  const overviewCache = new Map<string, { timestamp: number; data: DashboardOverviewResponse }>();
  const apiCallTimestamps: number[] = [];

  function broadcast(type: string, payload: unknown): void {
    options.onBroadcast?.(type, payload);
  }

  function getRequestsLastMinute(): number {
    const cutoff = Date.now() - 60_000;
    while (apiCallTimestamps.length > 0 && apiCallTimestamps[0] < cutoff) {
      apiCallTimestamps.shift();
    }
    return apiCallTimestamps.length;
  }

  async function aimfoxFetch<T>(apiPath: string, init?: RequestInit): Promise<T> {
    const apiKey = getAimfoxApiKey();
    if (!apiKey) {
      throw new Error(
        'AIMFOX_API_KEY is not configured. Add AIMFOX_API_KEY to your server environment variables.',
      );
    }

    const currentCount = getRequestsLastMinute();
    if (currentCount >= RATE_LIMIT_PER_MIN - 2) {
      throw new Error('Aimfox API rate limit guard reached (60 req/min). Using cached metrics.');
    }

    apiCallTimestamps.push(Date.now());
    const res = await fetch(`${AIMFOX_BASE_URL}${apiPath}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Aimfox returned non-JSON response (${res.status})`);
    }

    if (!res.ok) {
      const errObj = json as { error?: { message?: string }; message?: string };
      const message = errObj?.error?.message || errObj?.message || `Aimfox API error ${res.status}`;
      throw new Error(message);
    }

    return json as T;
  }

  function getRangeBounds(range: TimeRange): { from: number; to: number } {
    const to = Date.now();
    const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
    const from = to - days * 24 * 60 * 60 * 1000;
    return { from, to };
  }

  function sumBuckets(buckets: InteractionBucket[]): CampaignMetrics {
    return buckets.reduce<CampaignMetrics>(
      (acc, b) => ({
        sent_connections: acc.sent_connections + (b.sent_connections || 0),
        accepted_connections: acc.accepted_connections + (b.accepted_connections || 0),
        sent_messages: acc.sent_messages + (b.sent_messages || 0),
        replies: acc.replies + (b.replies || 0),
        inmail_replies: acc.inmail_replies + (b.inmail_replies || 0),
        sent_inmails: acc.sent_inmails + (b.sent_inmails || 0),
        message_requests: acc.message_requests + (b.message_requests || 0),
        sent_endorsements: acc.sent_endorsements + (b.sent_endorsements || 0),
        views: acc.views + (b.views || 0),
        sent_likes: acc.sent_likes + (b.sent_likes || 0),
      }),
      {
        sent_connections: 0,
        accepted_connections: 0,
        sent_messages: 0,
        replies: 0,
        inmail_replies: 0,
        sent_inmails: 0,
        message_requests: 0,
        sent_endorsements: 0,
        views: 0,
        sent_likes: 0,
      },
    );
  }

  function calcRate(numerator: number, denominator: number): number {
    if (!denominator || denominator <= 0) return 0;
    return Number(((numerator / denominator) * 100).toFixed(1));
  }

  function resolveOrigin(req: Request): string {
    const configuredAppUrl = process.env.APP_URL?.trim();
    if (configuredAppUrl && configuredAppUrl !== 'MY_APP_URL') {
      return configuredAppUrl.replace(/\/$/, '');
    }
    const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
    return `${proto}://${host}`;
  }

  function resolveWebhookUrl(req: Request): string {
    return `${resolveOrigin(req)}/api/webhooks/aimfox`;
  }

  async function buildDashboardOverview(
    range: TimeRange,
    accountId: string,
    campaignId: string,
    req: Request,
    forceRefresh = false,
  ): Promise<DashboardOverviewResponse> {
    const cacheKey = `${range}:${accountId}:${campaignId}`;
    const cached = overviewCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return {
        ...cached.data,
        fromCache: true,
        rateLimit: {
          requestsLastMinute: getRequestsLastMinute(),
          limitPerMinute: RATE_LIMIT_PER_MIN,
        },
        webhookEvents: persistedStore.webhookEvents,
      };
    }

    const { from, to } = getRangeBounds(range);

    const [accountsRes, campaignsRes, recentLeadsRes, templatesRes, conversationsRes, webhooksRes] =
      await Promise.all([
        aimfoxFetch<{ accounts: AimfoxAccount[] }>('/api/v2/accounts'),
        aimfoxFetch<{ campaigns: AimfoxCampaign[] }>('/api/v2/campaigns'),
        aimfoxFetch<{ leads: RecentLeadEvent[] }>('/api/v2/analytics/recent-leads').catch(() => ({
          leads: [] as RecentLeadEvent[],
        })),
        aimfoxFetch<{ templates: AimfoxTemplate[] }>('/api/v2/templates').catch(() => ({
          templates: [] as AimfoxTemplate[],
        })),
        aimfoxFetch<{ conversations: AimfoxConversation[] }>('/api/v2/conversations').catch(() => ({
          conversations: [] as AimfoxConversation[],
        })),
        aimfoxFetch<{ webhooks: AimfoxWebhookConfig[] }>('/api/v3/webhooks').catch(() => ({
          webhooks: [] as AimfoxWebhookConfig[],
        })),
      ]);

    const rawAccounts = accountsRes.accounts || [];
    const rawCampaigns = campaignsRes.campaigns || [];
    const recentLeads = recentLeadsRes.leads || [];
    const templates = templatesRes.templates || [];
    const conversations = conversationsRes.conversations || [];
    const webhooks = webhooksRes.webhooks || [];

    const userPerformance: UserPerformanceRow[] = await Promise.all(
      rawAccounts.map(async (acc) => {
        const [limitsRes, interactionsRes] = await Promise.all([
          aimfoxFetch<{ limit: AimfoxAccountLimits }>(`/api/v2/accounts/${acc.id}/limits`).catch(
            () => ({ limit: null }),
          ),
          aimfoxFetch<{ buckets: InteractionBucket[] }>(
            `/api/v2/analytics/interactions?from=${from}&to=${to}&bucket=${encodeURIComponent('1 day')}&account_ids[]=${encodeURIComponent(acc.id)}`,
          ).catch(() => ({ buckets: [] as InteractionBucket[] })),
        ]);

        acc.limits = limitsRes.limit;
        const accBuckets = interactionsRes.buckets || [];
        const accTotals = sumBuckets(accBuckets);
        const latestBucket = accBuckets[accBuckets.length - 1];
        const activeCampaignsCount = rawCampaigns.filter(
          (c) => c.state === 'ACTIVE' && c.owners?.includes(acc.id),
        ).length;
        const unreadConversationsCount = conversations.filter(
          (conv) =>
            conv.unread_count > 0 &&
            String(conv.last_message?.account_id || acc.id) === String(acc.id),
        ).length;

        return {
          account: acc,
          totals: accTotals,
          acceptanceRate: calcRate(accTotals.accepted_connections, accTotals.sent_connections),
          replyRate: calcRate(accTotals.replies, accTotals.sent_messages + accTotals.sent_connections),
          todayConnections: latestBucket?.sent_connections || 0,
          todayMessages: latestBucket?.sent_messages || 0,
          dailyConnectLimit: limitsRes.limit?.connect ?? 200,
          dailyInmailLimit: limitsRes.limit?.inmail ?? 100,
          activeCampaignsCount,
          unreadConversationsCount,
          buckets: accBuckets,
        };
      }),
    );

    const enrichedCampaigns: AimfoxCampaign[] = await Promise.all(
      rawCampaigns.map(async (campaign) => {
        const [metricsRes, detailRes] = await Promise.all([
          aimfoxFetch<{ metrics: CampaignMetrics }>(`/api/v2/campaigns/${campaign.id}/metrics`).catch(
            () => ({ metrics: undefined }),
          ),
          aimfoxFetch<{ campaign: Partial<AimfoxCampaign> }>(`/api/v2/campaigns/${campaign.id}`).catch(
            () => ({ campaign: {} as Partial<AimfoxCampaign> }),
          ),
        ]);
        return {
          ...campaign,
          completion: detailRes.campaign?.completion ?? campaign.completion ?? 0,
          metrics: metricsRes.metrics,
        };
      }),
    );

    const queryParts = [
      `from=${from}`,
      `to=${to}`,
      `bucket=${encodeURIComponent('1 day')}`,
    ];
    if (accountId && accountId !== 'all') {
      queryParts.push(`account_ids[]=${encodeURIComponent(accountId)}`);
    }
    if (campaignId && campaignId !== 'all') {
      queryParts.push(`campaign_id=${encodeURIComponent(campaignId)}`);
    }

    const mainBucketsRes = await aimfoxFetch<{ buckets: InteractionBucket[] }>(
      `/api/v2/analytics/interactions?${queryParts.join('&')}`,
    ).catch(() => ({ buckets: [] as InteractionBucket[] }));

    const buckets = mainBucketsRes.buckets || [];
    const summed = sumBuckets(buckets);

    const filteredCampaigns = enrichedCampaigns.filter((c) => {
      if (accountId !== 'all' && !c.owners?.includes(accountId)) return false;
      if (campaignId !== 'all' && c.id !== campaignId) return false;
      return true;
    });

    const totalTargets = filteredCampaigns.reduce((sum, c) => sum + (c.target_count || 0), 0);
    const unreadConversations = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);

    const filteredRecentLeads = recentLeads.filter((lead) => {
      if (accountId !== 'all' && lead.account_id !== accountId && lead.owner !== accountId) {
        return false;
      }
      if (campaignId !== 'all' && lead.campaign_id !== campaignId) {
        return false;
      }
      return true;
    });

    const workspaceId = rawAccounts[0]?.workspace_id || '0394d6e3-a4d5-49df-ba04-f572a03004f3';

    const result: DashboardOverviewResponse = {
      customer: {
        fullName: 'Jason Thompson',
        email: 'jason@aurorasalesagency.com',
        workspaceName: 'Baby George Creative',
        workspaceId,
      },
      range,
      accountId,
      campaignId,
      syncedAt: new Date().toISOString(),
      fromCache: false,
      rateLimit: {
        requestsLastMinute: getRequestsLastMinute(),
        limitPerMinute: RATE_LIMIT_PER_MIN,
      },
      webhookEndpointUrl: resolveWebhookUrl(req),
      webhookSecretConfigured: Boolean(getWebhookSecret()),
      accounts: rawAccounts,
      campaigns: enrichedCampaigns,
      buckets,
      totals: {
        ...summed,
        acceptanceRate: calcRate(summed.accepted_connections, summed.sent_connections),
        replyRate: calcRate(summed.replies, summed.sent_messages),
        totalTargets,
        unreadConversations,
      },
      userPerformance,
      recentLeads: filteredRecentLeads,
      templates,
      conversations,
      webhooks,
      webhookEvents: persistedStore.webhookEvents,
    };

    overviewCache.set(cacheKey, { timestamp: Date.now(), data: result });
    return result;
  }

  function ingestWebhookPayload(body: {
    id?: string;
    event_type?: string;
    workspace?: string;
    event?: Record<string, unknown>;
    is_test?: boolean;
  }): { storedEvent: StoredWebhookEvent; deduplicated: boolean } {
    const eventId = body?.id || `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const eventType = body?.event_type || 'unknown_event';
    const workspace = body?.workspace || '0394d6e3-a4d5-49df-ba04-f572a03004f3';

    const existing = persistedStore.webhookEvents.find((e) => e.id === eventId);
    if (existing) {
      return { storedEvent: existing, deduplicated: true };
    }

    const storedEvent: StoredWebhookEvent = {
      id: eventId,
      event_type: eventType,
      workspace,
      received_at: new Date().toISOString(),
      is_test: Boolean(body?.is_test),
      event: body?.event || {},
    };

    persistedStore.webhookEvents = [storedEvent, ...persistedStore.webhookEvents].slice(0, 200);
    saveStore(persistedStore);
    overviewCache.clear();
    broadcast('webhook:received', storedEvent);

    return { storedEvent, deduplicated: false };
  }

  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      wsSupported: options.wsSupported,
      rateLimit: {
        requestsLastMinute: getRequestsLastMinute(),
        limitPerMinute: RATE_LIMIT_PER_MIN,
      },
      wsClients: options.getWsClientCount?.() ?? 0,
      webhookUrl: resolveWebhookUrl(req),
      webhookSecretConfigured: Boolean(getWebhookSecret()),
      aimfoxConfigured: Boolean(getAimfoxApiKey()),
    });
  });

  app.get('/api/dashboard/overview', async (req: Request, res: Response) => {
    try {
      const rawRange = String(req.query.range || '30d');
      const range: TimeRange = rawRange === '7d' || rawRange === '90d' ? rawRange : '30d';
      const accountId = String(req.query.accountId || 'all');
      const campaignId = String(req.query.campaignId || 'all');
      const force = req.query.force === 'true';

      const data = await buildDashboardOverview(range, accountId, campaignId, req, force);
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load Aimfox analytics';
      const status = message.includes('AIMFOX_API_KEY') ? 503 : 502;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/dashboard/sync', async (req: Request, res: Response) => {
    try {
      const range = (req.body?.range as TimeRange) || '30d';
      const accountId = String(req.body?.accountId || 'all');
      const campaignId = String(req.body?.campaignId || 'all');

      overviewCache.clear();
      const data = await buildDashboardOverview(range, accountId, campaignId, req, true);
      broadcast('dashboard:synced', { syncedAt: data.syncedAt, range });
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      res.status(502).json({ error: message });
    }
  });

  app.patch('/api/aimfox/campaigns/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { state } = req.body as { state?: string };
      if (state !== 'ACTIVE' && state !== 'PAUSED') {
        res.status(400).json({ error: 'state must be ACTIVE or PAUSED' });
        return;
      }

      const result = await aimfoxFetch<Record<string, unknown>>(
        `/api/v2/campaigns/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ state }),
        },
      );

      overviewCache.clear();
      broadcast('campaign:updated', { campaignId: id, state });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update campaign';
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/aimfox/leads/search', async (req: Request, res: Response) => {
    try {
      const query = String(req.body?.query || '').trim();
      const count = Math.min(Number(req.body?.count || 25), 50);
      const bodyPayload: Record<string, unknown> = { count };
      if (query) {
        bodyPayload.keywords = query;
      }
      const data = await aimfoxFetch<{ leads: unknown[] }>('/api/v2/leads:search', {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      });
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lead search failed';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/aimfox/conversations/:urn', async (req: Request, res: Response) => {
    try {
      const { urn } = req.params;
      const accountId = String(req.query.accountId || '');
      const endpoint = accountId
        ? `/api/v2/accounts/${encodeURIComponent(accountId)}/conversations/${encodeURIComponent(urn)}`
        : `/api/v2/conversations/${encodeURIComponent(urn)}`;
      const data = await aimfoxFetch<Record<string, unknown>>(endpoint);
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch conversation';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/aimfox/webhooks', async (_req: Request, res: Response) => {
    try {
      const data = await aimfoxFetch<{ webhooks: AimfoxWebhookConfig[] }>('/api/v3/webhooks');
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list webhooks';
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/aimfox/webhooks', async (req: Request, res: Response) => {
    try {
      const { name, url, events, includeAuthHeader } = req.body as {
        name?: string;
        url?: string;
        events?: string[];
        includeAuthHeader?: boolean;
      };
      if (!name || !url || !Array.isArray(events) || events.length === 0) {
        res.status(400).json({ error: 'name, url, and at least one event are required' });
        return;
      }

      const webhookSecret = getWebhookSecret();
      const payload: Record<string, unknown> = {
        name,
        url,
        events,
      };
      if (includeAuthHeader && webhookSecret) {
        payload.headers = {
          Authorization: `Bearer ${webhookSecret}`,
        };
      }

      const data = await aimfoxFetch<Record<string, unknown>>('/api/v3/webhooks', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      overviewCache.clear();
      broadcast('webhooks:changed', data);
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to register webhook on Aimfox';
      res.status(502).json({ error: message });
    }
  });

  app.delete('/api/aimfox/webhooks/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data = await aimfoxFetch<Record<string, unknown>>(
        `/api/v3/webhooks/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      overviewCache.clear();
      broadcast('webhooks:changed', { deletedId: id });
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete webhook';
      res.status(502).json({ error: message });
    }
  });

  // Real-time Aimfox Webhook Receiver — works with OR without AIMFOX_WEBHOOK_SECRET
  app.post('/api/webhooks/aimfox', (req: Request, res: Response) => {
    const expectedSecret = getWebhookSecret();
    if (expectedSecret) {
      const authHeader = req.headers.authorization || '';
      if (authHeader !== `Bearer ${expectedSecret}`) {
        res.status(401).json({ error: 'Unauthorized webhook signature' });
        return;
      }
    }

    const { storedEvent, deduplicated } = ingestWebhookPayload(req.body || {});
    res.status(200).json({ received: true, deduplicated, id: storedEvent.id });
  });

  app.post('/api/webhooks/aimfox/test', (req: Request, res: Response) => {
    const eventType = String(req.body?.event_type || 'campaign_reply');
    const testPayload = {
      id: `evt_live_test_${Date.now()}`,
      event_type: eventType,
      workspace: '0394d6e3-a4d5-49df-ba04-f572a03004f3',
      is_test: true,
      event: {
        account_id: '1323214698',
        account_name: 'Tshepo Maseko',
        campaign_id: 'e838a1a4-8998-4920-aba1-90023b1ac995',
        campaign_name: 'Baby George Creative',
        lead_name: req.body?.lead_name || 'Ciske Momberg',
        lead_occupation: 'SEO & Content Strategy Lead',
        message_preview:
          eventType === 'campaign_reply' || eventType === 'reply'
            ? 'Thanks Tshepo — we have two brand activations in Q1, let us schedule a call.'
            : undefined,
        timestamp: new Date().toISOString(),
      },
    };

    const { storedEvent, deduplicated } = ingestWebhookPayload(testPayload);
    res.status(200).json({ received: true, deduplicated, id: storedEvent.id, event: storedEvent });
  });

  app.get('/api/webhooks/events', (_req: Request, res: Response) => {
    res.json({ events: persistedStore.webhookEvents });
  });

  app.delete('/api/webhooks/events', (_req: Request, res: Response) => {
    persistedStore.webhookEvents = [];
    saveStore(persistedStore);
    broadcast('webhooks:cleared', {});
    res.json({ cleared: true });
  });

  app.get('/api/export/csv', async (req: Request, res: Response) => {
    try {
      const rawRange = String(req.query.range || '30d');
      const range: TimeRange = rawRange === '7d' || rawRange === '90d' ? rawRange : '30d';
      const accountId = String(req.query.accountId || 'all');
      const campaignId = String(req.query.campaignId || 'all');

      const overview = await buildDashboardOverview(range, accountId, campaignId, req, false);
      const header = [
        'Date',
        'Profile Views',
        'Sent Connections',
        'Accepted Connections',
        'Acceptance Rate (%)',
        'Sent Messages',
        'Replies',
        'Reply Rate (%)',
        'Likes',
        'Endorsements',
      ].join(',');

      const rows = overview.buckets.map((b) => {
        const dateStr = new Date(b.timestamp).toISOString().split('T')[0];
        const accRate = calcRate(b.accepted_connections, b.sent_connections);
        const repRate = calcRate(b.replies, b.sent_messages);
        return [
          dateStr,
          b.views,
          b.sent_connections,
          b.accepted_connections,
          accRate,
          b.sent_messages,
          b.replies,
          repRate,
          b.sent_likes,
          b.sent_endorsements,
        ].join(',');
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="aimfox-${overview.customer.workspaceName.toLowerCase().replace(/\s+/g, '-')}-${range}.csv"`,
      );
      res.send([header, ...rows].join('\n'));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed';
      res.status(500).json({ error: message });
    }
  });

  return app;
}
