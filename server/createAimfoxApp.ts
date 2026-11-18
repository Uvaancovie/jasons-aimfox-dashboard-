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
  CampaignsPageResponse,
  CustomerProfile,
  DashboardOverviewResponse,
  InteractionBucket,
  LeadsPageResponse,
  OverviewPageResponse,
  RecentLeadEvent,
  StoredWebhookEvent,
  TimeRange,
  UserPerformanceRow,
  UsersPageResponse,
  WebhooksPageResponse,
} from '../src/types/aimfox.ts';

const AIMFOX_BASE_URL = 'https://api.aimfox.com';
const RATE_LIMIT_PER_MIN = 60;
const STALE_MAX_AGE_MS = 30 * 60 * 1000; // 30m SWR ceiling

const TTL = {
  ACCOUNTS: 5 * 60 * 1000,
  LIMITS: 5 * 60 * 1000,
  CAMPAIGNS: 3 * 60 * 1000,
  CAMPAIGN_METRICS: 2 * 60 * 1000,
  TEMPLATES: 5 * 60 * 1000,
  WEBHOOKS: 3 * 60 * 1000,
  INTERACTIONS: 90 * 1000,
  RECENT_LEADS: 90 * 1000,
  CONVERSATIONS: 90 * 1000,
};

interface CachedEntry<T = unknown> {
  cachedAt: number;
  data: T;
}

interface PersistedStore {
  webhookEvents: StoredWebhookEvent[];
  resourceCache: Record<string, CachedEntry>;
  tokensSaved: number;
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
    return { webhookEvents: [], resourceCache: {}, tokensSaved: 0 };
  }
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedStore>;
    return {
      webhookEvents: Array.isArray(parsed.webhookEvents) ? parsed.webhookEvents : [],
      resourceCache:
        parsed.resourceCache && typeof parsed.resourceCache === 'object'
          ? parsed.resourceCache
          : {},
      tokensSaved: typeof parsed.tokensSaved === 'number' ? parsed.tokensSaved : 0,
    };
  } catch {
    return { webhookEvents: [], resourceCache: {}, tokensSaved: 0 };
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSaveStore(store: PersistedStore): void {
  if (process.env.VERCEL) {
    try {
      fs.writeFileSync(getStorePath(), JSON.stringify(store), 'utf-8');
    } catch {
      // ignore in ephemeral environments
    }
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(getStorePath(), JSON.stringify(store), 'utf-8');
    } catch {
      // ignore write error
    }
  }, 400);
}

function saveStoreImmediate(store: PersistedStore): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.writeFileSync(getStorePath(), JSON.stringify(store), 'utf-8');
  } catch {
    // ignore write error
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
  const inFlightRequests = new Map<string, Promise<unknown>>();
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

  async function aimfoxFetchRaw<T>(apiPath: string, init?: RequestInit): Promise<T> {
    const apiKey = getAimfoxApiKey();
    if (!apiKey) {
      throw new Error(
        'AIMFOX_API_KEY is not configured. Add AIMFOX_API_KEY to your server environment variables.',
      );
    }

    const currentCount = getRequestsLastMinute();
    if (currentCount >= RATE_LIMIT_PER_MIN - 2) {
      throw new Error('Aimfox API rate limit guard reached (60 req/min). Using cached data.');
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

  interface FetchCachedResult<T> {
    data: T;
    hit: boolean;
    staleRevalidating: boolean;
    cachedAt: number;
  }

  async function fetchCachedResource<T>(
    cacheKey: string,
    apiPath: string,
    freshTtlMs: number,
    force = false,
    fallbackValue?: T,
  ): Promise<FetchCachedResult<T>> {
    const now = Date.now();
    const existing = persistedStore.resourceCache[cacheKey] as CachedEntry<T> | undefined;

    if (!force && existing) {
      const age = now - existing.cachedAt;
      if (age <= freshTtlMs) {
        persistedStore.tokensSaved += 1;
        return {
          data: existing.data,
          hit: true,
          staleRevalidating: false,
          cachedAt: existing.cachedAt,
        };
      }
      if (age <= STALE_MAX_AGE_MS) {
        persistedStore.tokensSaved += 1;
        // Stale-while-revalidate: return immediately, refresh in background if not already in-flight
        if (!inFlightRequests.has(cacheKey) && getRequestsLastMinute() < RATE_LIMIT_PER_MIN - 8) {
          const bgPromise = aimfoxFetchRaw<T>(apiPath)
            .then((freshData) => {
              persistedStore.resourceCache[cacheKey] = {
                cachedAt: Date.now(),
                data: freshData,
              };
              scheduleSaveStore(persistedStore);
              broadcast('cache:revalidated', { key: cacheKey });
              return freshData;
            })
            .catch(() => existing.data)
            .finally(() => {
              inFlightRequests.delete(cacheKey);
            });
          inFlightRequests.set(cacheKey, bgPromise);
        }
        return {
          data: existing.data,
          hit: true,
          staleRevalidating: true,
          cachedAt: existing.cachedAt,
        };
      }
    }

    // Deduplicate concurrent network calls for the same key
    const existingInFlight = inFlightRequests.get(cacheKey) as Promise<T> | undefined;
    if (existingInFlight) {
      const data = await existingInFlight;
      return { data, hit: true, staleRevalidating: false, cachedAt: Date.now() };
    }

    const promise = aimfoxFetchRaw<T>(apiPath)
      .then((freshData) => {
        persistedStore.resourceCache[cacheKey] = {
          cachedAt: Date.now(),
          data: freshData,
        };
        scheduleSaveStore(persistedStore);
        return freshData;
      })
      .catch((err) => {
        if (existing) {
          return existing.data;
        }
        if (fallbackValue !== undefined) {
          return fallbackValue;
        }
        throw err;
      })
      .finally(() => {
        inFlightRequests.delete(cacheKey);
      });

    inFlightRequests.set(cacheKey, promise);
    const data = await promise;
    const savedEntry = persistedStore.resourceCache[cacheKey];
    return {
      data,
      hit: false,
      staleRevalidating: false,
      cachedAt: savedEntry?.cachedAt ?? Date.now(),
    };
  }

  function getRangeBounds(range: TimeRange): { from: number; to: number } {
    // Round `to` to the current 5-minute bucket so cache keys stay stable across fast clicks
    const fiveMinMs = 5 * 60 * 1000;
    const to = Math.ceil(Date.now() / fiveMinMs) * fiveMinMs;
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

  function buildCustomerProfile(accounts: AimfoxAccount[]): CustomerProfile {
    return {
      fullName: 'Jason Thompson',
      email: 'jason@aurorasalesagency.com',
      workspaceName: 'Baby George Creative',
      workspaceId: accounts[0]?.workspace_id || '0394d6e3-a4d5-49df-ba04-f572a03004f3',
    };
  }

  async function getBaseAccountsAndCampaigns(force = false) {
    const [accountsRes, campaignsRes] = await Promise.all([
      fetchCachedResource<{ accounts: AimfoxAccount[] }>(
        'accounts:list',
        '/api/v2/accounts',
        TTL.ACCOUNTS,
        force,
      ),
      fetchCachedResource<{ campaigns: AimfoxCampaign[] }>(
        'campaigns:list',
        '/api/v2/campaigns',
        TTL.CAMPAIGNS,
        force,
      ),
    ]);
    return {
      accounts: accountsRes.data.accounts || [],
      campaigns: campaignsRes.data.campaigns || [],
      accountsHit: accountsRes.hit,
      campaignsHit: campaignsRes.hit,
      oldestCachedAt: Math.min(accountsRes.cachedAt, campaignsRes.cachedAt),
    };
  }

  async function buildUserPerformance(
    accounts: AimfoxAccount[],
    campaigns: AimfoxCampaign[],
    conversations: AimfoxConversation[],
    range: TimeRange,
    force = false,
  ): Promise<{ rows: UserPerformanceRow[]; allHit: boolean; staleRevalidating: boolean }> {
    const { from, to } = getRangeBounds(range);
    let allHit = true;
    let staleRevalidating = false;

    const rows = await Promise.all(
      accounts.map(async (acc) => {
        const [limitsRes, interactionsRes] = await Promise.all([
          fetchCachedResource<{ limit: AimfoxAccountLimits | null }>(
            `account:${acc.id}:limits`,
            `/api/v2/accounts/${acc.id}/limits`,
            TTL.LIMITS,
            force,
            { limit: null },
          ),
          fetchCachedResource<{ buckets: InteractionBucket[] }>(
            `interactions:${range}:acc:${acc.id}`,
            `/api/v2/analytics/interactions?from=${from}&to=${to}&bucket=${encodeURIComponent('1 day')}&account_ids=${encodeURIComponent(JSON.stringify([acc.id]))}`,
            TTL.INTERACTIONS,
            force,
            { buckets: [] },
          ),
        ]);

        if (!limitsRes.hit || !interactionsRes.hit) allHit = false;
        if (limitsRes.staleRevalidating || interactionsRes.staleRevalidating) {
          staleRevalidating = true;
        }

        const accCopy: AimfoxAccount = { ...acc, limits: limitsRes.data.limit };
        const accBuckets = interactionsRes.data.buckets || [];
        const accTotals = sumBuckets(accBuckets);
        const latestBucket = accBuckets[accBuckets.length - 1];
        const activeCampaignsCount = campaigns.filter(
          (c) => c.state === 'ACTIVE' && c.owners?.includes(acc.id),
        ).length;
        const unreadConversationsCount = conversations.filter(
          (conv) =>
            conv.unread_count > 0 &&
            String(conv.last_message?.account_id || acc.id) === String(acc.id),
        ).length;

        return {
          account: accCopy,
          totals: accTotals,
          acceptanceRate: calcRate(accTotals.accepted_connections, accTotals.sent_connections),
          replyRate: calcRate(
            accTotals.replies,
            accTotals.sent_messages + accTotals.sent_connections,
          ),
          todayConnections: latestBucket?.sent_connections || 0,
          todayMessages: latestBucket?.sent_messages || 0,
          dailyConnectLimit: limitsRes.data.limit?.connect ?? 200,
          dailyInmailLimit: limitsRes.data.limit?.inmail ?? 100,
          activeCampaignsCount,
          unreadConversationsCount,
          buckets: accBuckets,
        };
      }),
    );

    return { rows, allHit, staleRevalidating };
  }

  async function getEnrichedCampaigns(
    rawCampaigns: AimfoxCampaign[],
    force = false,
  ): Promise<{ campaigns: AimfoxCampaign[]; allHit: boolean }> {
    let allHit = true;
    const campaigns = await Promise.all(
      rawCampaigns.map(async (campaign) => {
        const [metricsRes, detailRes] = await Promise.all([
          fetchCachedResource<{ metrics?: CampaignMetrics }>(
            `campaign:${campaign.id}:metrics`,
            `/api/v2/campaigns/${campaign.id}/metrics`,
            TTL.CAMPAIGN_METRICS,
            force,
            { metrics: undefined },
          ),
          fetchCachedResource<{ campaign?: Partial<AimfoxCampaign> }>(
            `campaign:${campaign.id}:detail`,
            `/api/v2/campaigns/${campaign.id}`,
            TTL.CAMPAIGNS,
            force,
            { campaign: {} },
          ),
        ]);
        if (!metricsRes.hit || !detailRes.hit) allHit = false;
        return {
          ...campaign,
          completion: detailRes.data.campaign?.completion ?? campaign.completion ?? 0,
          metrics: metricsRes.data.metrics,
        };
      }),
    );
    return { campaigns, allHit };
  }

  function makeCacheHeaders(res: Response, hit: boolean, stale: boolean): void {
    res.setHeader('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
    res.setHeader('X-Cache', stale ? 'STALE' : hit ? 'HIT' : 'MISS');
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
    saveStoreImmediate(persistedStore);
    broadcast('webhook:received', storedEvent);

    return { storedEvent, deduplicated: false };
  }

  // Health & telemetry route
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      wsSupported: options.wsSupported,
      rateLimit: {
        requestsLastMinute: getRequestsLastMinute(),
        limitPerMinute: RATE_LIMIT_PER_MIN,
      },
      tokensSaved: persistedStore.tokensSaved,
      wsClients: options.getWsClientCount?.() ?? 0,
      webhookUrl: resolveWebhookUrl(req),
      webhookSecretConfigured: Boolean(getWebhookSecret()),
      aimfoxConfigured: Boolean(getAimfoxApiKey()),
    });
  });

  // Page 1: /overview — minimal Aimfox queries (accounts, campaigns, filtered buckets, recent leads)
  app.get('/api/pages/overview', async (req: Request, res: Response) => {
    try {
      const rawRange = String(req.query.range || '30d');
      const range: TimeRange = rawRange === '7d' || rawRange === '90d' ? rawRange : '30d';
      const accountId = String(req.query.accountId || 'all');
      const campaignId = String(req.query.campaignId || 'all');
      const force = req.query.force === 'true';

      const { accounts, campaigns, accountsHit, campaignsHit, oldestCachedAt } =
        await getBaseAccountsAndCampaigns(force);

      const { from, to } = getRangeBounds(range);
      const queryParts = [`from=${from}`, `to=${to}`, `bucket=${encodeURIComponent('1 day')}`];
      if (accountId !== 'all') {
        queryParts.push(`account_ids=${encodeURIComponent(JSON.stringify([accountId]))}`);
      }
      if (campaignId !== 'all') queryParts.push(`campaign_id=${encodeURIComponent(campaignId)}`);

      const interactionCacheKey =
        accountId !== 'all' && campaignId === 'all'
          ? `interactions:${range}:acc:${accountId}`
          : `interactions:${range}:${accountId}:${campaignId}`;

      const [bucketsRes, recentLeadsRes, conversationsRes, userPerf] = await Promise.all([
        fetchCachedResource<{ buckets: InteractionBucket[] }>(
          interactionCacheKey,
          `/api/v2/analytics/interactions?${queryParts.join('&')}`,
          TTL.INTERACTIONS,
          force,
          { buckets: [] },
        ),
        fetchCachedResource<{ leads: RecentLeadEvent[] }>(
          'recent-leads',
          '/api/v2/analytics/recent-leads',
          TTL.RECENT_LEADS,
          force,
          { leads: [] },
        ),
        fetchCachedResource<{ conversations: AimfoxConversation[] }>(
          'conversations',
          '/api/v2/conversations',
          TTL.CONVERSATIONS,
          force,
          { conversations: [] },
        ),
        buildUserPerformance(accounts, campaigns, [], range, force),
      ]);

      const buckets = bucketsRes.data.buckets || [];
      const summed = sumBuckets(buckets);
      const conversations = conversationsRes.data.conversations || [];

      const filteredCampaigns = campaigns.filter((c) => {
        if (accountId !== 'all' && !c.owners?.includes(accountId)) return false;
        if (campaignId !== 'all' && c.id !== campaignId) return false;
        return true;
      });
      const totalTargets = filteredCampaigns.reduce((sum, c) => sum + (c.target_count || 0), 0);
      const unreadConversations = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);

      const filteredRecentLeads = (recentLeadsRes.data.leads || []).filter((lead) => {
        if (accountId !== 'all' && lead.account_id !== accountId && lead.owner !== accountId) {
          return false;
        }
        if (campaignId !== 'all' && lead.campaign_id !== campaignId) return false;
        return true;
      });

      const allHit =
        accountsHit &&
        campaignsHit &&
        bucketsRes.hit &&
        recentLeadsRes.hit &&
        userPerf.allHit;
      const stale = bucketsRes.staleRevalidating || userPerf.staleRevalidating;

      makeCacheHeaders(res, allHit, stale);
      const response: OverviewPageResponse = {
        customer: buildCustomerProfile(accounts),
        syncedAt: new Date(bucketsRes.cachedAt || oldestCachedAt).toISOString(),
        cache: {
          hit: allHit,
          staleRevalidating: stale,
          ageSeconds: Math.max(0, Math.round((Date.now() - bucketsRes.cachedAt) / 1000)),
          requestsLastMinute: getRequestsLastMinute(),
          limitPerMinute: RATE_LIMIT_PER_MIN,
          tokensSavedEstimate: persistedStore.tokensSaved,
        },
        accounts,
        campaigns,
        range,
        accountId,
        campaignId,
        buckets,
        totals: {
          ...summed,
          acceptanceRate: calcRate(summed.accepted_connections, summed.sent_connections),
          replyRate: calcRate(summed.replies, summed.sent_messages),
          totalTargets,
          unreadConversations,
        },
        userPerformance: userPerf.rows,
        recentLeads: filteredRecentLeads,
        webhookEvents: persistedStore.webhookEvents,
      };
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load overview';
      res.status(message.includes('AIMFOX_API_KEY') ? 503 : 502).json({ error: message });
    }
  });

  // Page 2: /users — seat-level quotas, conversions, and owned campaigns
  app.get('/api/pages/users', async (req: Request, res: Response) => {
    try {
      const rawRange = String(req.query.range || '30d');
      const range: TimeRange = rawRange === '7d' || rawRange === '90d' ? rawRange : '30d';
      const force = req.query.force === 'true';

      const { accounts, campaigns: rawCampaigns, accountsHit, campaignsHit, oldestCachedAt } =
        await getBaseAccountsAndCampaigns(force);

      const [{ campaigns }, userPerf] = await Promise.all([
        getEnrichedCampaigns(rawCampaigns, force),
        buildUserPerformance(accounts, rawCampaigns, [], range, force),
      ]);

      const allHit = accountsHit && campaignsHit && userPerf.allHit;
      makeCacheHeaders(res, allHit, userPerf.staleRevalidating);
      const response: UsersPageResponse = {
        customer: buildCustomerProfile(accounts),
        syncedAt: new Date(oldestCachedAt).toISOString(),
        cache: {
          hit: allHit,
          staleRevalidating: userPerf.staleRevalidating,
          ageSeconds: Math.max(0, Math.round((Date.now() - oldestCachedAt) / 1000)),
          requestsLastMinute: getRequestsLastMinute(),
          limitPerMinute: RATE_LIMIT_PER_MIN,
          tokensSavedEstimate: persistedStore.tokensSaved,
        },
        accounts,
        campaigns,
        range,
        userPerformance: userPerf.rows,
      };
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load user metrics';
      res.status(message.includes('AIMFOX_API_KEY') ? 503 : 502).json({ error: message });
    }
  });

  // Page 3: /campaigns — campaigns + metrics + templates
  app.get('/api/pages/campaigns', async (req: Request, res: Response) => {
    try {
      const force = req.query.force === 'true';
      const { accounts, campaigns: rawCampaigns, accountsHit, campaignsHit, oldestCachedAt } =
        await getBaseAccountsAndCampaigns(force);

      const [enriched, templatesRes] = await Promise.all([
        getEnrichedCampaigns(rawCampaigns, force),
        fetchCachedResource<{ templates: AimfoxTemplate[] }>(
          'templates',
          '/api/v2/templates',
          TTL.TEMPLATES,
          force,
          { templates: [] },
        ),
      ]);

      const allHit = accountsHit && campaignsHit && enriched.allHit && templatesRes.hit;
      makeCacheHeaders(res, allHit, templatesRes.staleRevalidating);
      const response: CampaignsPageResponse = {
        customer: buildCustomerProfile(accounts),
        syncedAt: new Date(oldestCachedAt).toISOString(),
        cache: {
          hit: allHit,
          staleRevalidating: templatesRes.staleRevalidating,
          ageSeconds: Math.max(0, Math.round((Date.now() - oldestCachedAt) / 1000)),
          requestsLastMinute: getRequestsLastMinute(),
          limitPerMinute: RATE_LIMIT_PER_MIN,
          tokensSavedEstimate: persistedStore.tokensSaved,
        },
        accounts,
        campaigns: enriched.campaigns,
        templates: templatesRes.data.templates || [],
      };
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load campaigns';
      res.status(message.includes('AIMFOX_API_KEY') ? 503 : 502).json({ error: message });
    }
  });

  // Page 4: /leads — recent transitions + conversations
  app.get('/api/pages/leads', async (req: Request, res: Response) => {
    try {
      const force = req.query.force === 'true';
      const { accounts, campaigns, accountsHit, campaignsHit, oldestCachedAt } =
        await getBaseAccountsAndCampaigns(force);

      const [recentLeadsRes, conversationsRes] = await Promise.all([
        fetchCachedResource<{ leads: RecentLeadEvent[] }>(
          'recent-leads',
          '/api/v2/analytics/recent-leads',
          TTL.RECENT_LEADS,
          force,
          { leads: [] },
        ),
        fetchCachedResource<{ conversations: AimfoxConversation[] }>(
          'conversations',
          '/api/v2/conversations',
          TTL.CONVERSATIONS,
          force,
          { conversations: [] },
        ),
      ]);

      const allHit = accountsHit && campaignsHit && recentLeadsRes.hit && conversationsRes.hit;
      const stale = recentLeadsRes.staleRevalidating || conversationsRes.staleRevalidating;
      makeCacheHeaders(res, allHit, stale);
      const response: LeadsPageResponse = {
        customer: buildCustomerProfile(accounts),
        syncedAt: new Date(conversationsRes.cachedAt || oldestCachedAt).toISOString(),
        cache: {
          hit: allHit,
          staleRevalidating: stale,
          ageSeconds: Math.max(0, Math.round((Date.now() - conversationsRes.cachedAt) / 1000)),
          requestsLastMinute: getRequestsLastMinute(),
          limitPerMinute: RATE_LIMIT_PER_MIN,
          tokensSavedEstimate: persistedStore.tokensSaved,
        },
        accounts,
        campaigns,
        recentLeads: recentLeadsRes.data.leads || [],
        conversations: conversationsRes.data.conversations || [],
      };
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load leads & inbox';
      res.status(message.includes('AIMFOX_API_KEY') ? 503 : 502).json({ error: message });
    }
  });

  // Page 5: /webhooks — Aimfox v3 webhooks + persisted live event log
  app.get('/api/pages/webhooks', async (req: Request, res: Response) => {
    try {
      const force = req.query.force === 'true';
      const { accounts, campaigns, accountsHit, campaignsHit } =
        await getBaseAccountsAndCampaigns(force);

      const webhooksRes = await fetchCachedResource<{ webhooks: AimfoxWebhookConfig[] }>(
        'webhooks:v3',
        '/api/v3/webhooks',
        TTL.WEBHOOKS,
        force,
        { webhooks: [] },
      );

      const allHit = accountsHit && campaignsHit && webhooksRes.hit;
      makeCacheHeaders(res, allHit, webhooksRes.staleRevalidating);
      const response: WebhooksPageResponse = {
        customer: buildCustomerProfile(accounts),
        syncedAt: new Date(webhooksRes.cachedAt).toISOString(),
        cache: {
          hit: allHit,
          staleRevalidating: webhooksRes.staleRevalidating,
          ageSeconds: Math.max(0, Math.round((Date.now() - webhooksRes.cachedAt) / 1000)),
          requestsLastMinute: getRequestsLastMinute(),
          limitPerMinute: RATE_LIMIT_PER_MIN,
          tokensSavedEstimate: persistedStore.tokensSaved,
        },
        accounts,
        campaigns,
        webhookEndpointUrl: resolveWebhookUrl(req),
        webhookSecretConfigured: Boolean(getWebhookSecret()),
        webhooks: webhooksRes.data.webhooks || [],
        webhookEvents: persistedStore.webhookEvents,
      };
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load webhooks';
      res.status(message.includes('AIMFOX_API_KEY') ? 503 : 502).json({ error: message });
    }
  });

  // Full combined overview (kept for backwards compatibility + Vue integration snippet)
  app.get('/api/dashboard/overview', async (req: Request, res: Response) => {
    try {
      const rawRange = String(req.query.range || '30d');
      const range: TimeRange = rawRange === '7d' || rawRange === '90d' ? rawRange : '30d';
      const accountId = String(req.query.accountId || 'all');
      const campaignId = String(req.query.campaignId || 'all');
      const force = req.query.force === 'true';

      const { accounts, campaigns: rawCampaigns, accountsHit, campaignsHit } =
        await getBaseAccountsAndCampaigns(force);

      const { from, to } = getRangeBounds(range);
      const queryParts = [`from=${from}`, `to=${to}`, `bucket=${encodeURIComponent('1 day')}`];
      if (accountId !== 'all') {
        queryParts.push(`account_ids=${encodeURIComponent(JSON.stringify([accountId]))}`);
      }
      if (campaignId !== 'all') queryParts.push(`campaign_id=${encodeURIComponent(campaignId)}`);

      const [
        enriched,
        bucketsRes,
        recentLeadsRes,
        templatesRes,
        conversationsRes,
        webhooksRes,
        userPerf,
      ] = await Promise.all([
        getEnrichedCampaigns(rawCampaigns, force),
        fetchCachedResource<{ buckets: InteractionBucket[] }>(
          `interactions:${range}:${accountId}:${campaignId}`,
          `/api/v2/analytics/interactions?${queryParts.join('&')}`,
          TTL.INTERACTIONS,
          force,
          { buckets: [] },
        ),
        fetchCachedResource<{ leads: RecentLeadEvent[] }>(
          'recent-leads',
          '/api/v2/analytics/recent-leads',
          TTL.RECENT_LEADS,
          force,
          { leads: [] },
        ),
        fetchCachedResource<{ templates: AimfoxTemplate[] }>(
          'templates',
          '/api/v2/templates',
          TTL.TEMPLATES,
          force,
          { templates: [] },
        ),
        fetchCachedResource<{ conversations: AimfoxConversation[] }>(
          'conversations',
          '/api/v2/conversations',
          TTL.CONVERSATIONS,
          force,
          { conversations: [] },
        ),
        fetchCachedResource<{ webhooks: AimfoxWebhookConfig[] }>(
          'webhooks:v3',
          '/api/v3/webhooks',
          TTL.WEBHOOKS,
          force,
          { webhooks: [] },
        ),
        buildUserPerformance(accounts, rawCampaigns, [], range, force),
      ]);

      const buckets = bucketsRes.data.buckets || [];
      const summed = sumBuckets(buckets);
      const conversations = conversationsRes.data.conversations || [];
      const totalTargets = enriched.campaigns
        .filter(
          (c) =>
            (accountId === 'all' || c.owners?.includes(accountId)) &&
            (campaignId === 'all' || c.id === campaignId),
        )
        .reduce((sum, c) => sum + (c.target_count || 0), 0);
      const unreadConversations = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);

      const allHit = accountsHit && campaignsHit && bucketsRes.hit;
      makeCacheHeaders(res, allHit, bucketsRes.staleRevalidating);
      const result: DashboardOverviewResponse = {
        customer: buildCustomerProfile(accounts),
        range,
        accountId,
        campaignId,
        syncedAt: new Date(bucketsRes.cachedAt).toISOString(),
        fromCache: allHit,
        rateLimit: {
          requestsLastMinute: getRequestsLastMinute(),
          limitPerMinute: RATE_LIMIT_PER_MIN,
        },
        webhookEndpointUrl: resolveWebhookUrl(req),
        webhookSecretConfigured: Boolean(getWebhookSecret()),
        accounts,
        campaigns: enriched.campaigns,
        buckets,
        totals: {
          ...summed,
          acceptanceRate: calcRate(summed.accepted_connections, summed.sent_connections),
          replyRate: calcRate(summed.replies, summed.sent_messages),
          totalTargets,
          unreadConversations,
        },
        userPerformance: userPerf.rows,
        recentLeads: (recentLeadsRes.data.leads || []).filter((lead) => {
          if (accountId !== 'all' && lead.account_id !== accountId && lead.owner !== accountId) {
            return false;
          }
          if (campaignId !== 'all' && lead.campaign_id !== campaignId) return false;
          return true;
        }),
        templates: templatesRes.data.templates || [],
        conversations,
        webhooks: webhooksRes.data.webhooks || [],
        webhookEvents: persistedStore.webhookEvents,
      };
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load Aimfox analytics';
      res.status(message.includes('AIMFOX_API_KEY') ? 503 : 502).json({ error: message });
    }
  });

  // Explicit cache-busting sync trigger
  app.post('/api/dashboard/sync', (_req: Request, res: Response) => {
    persistedStore.resourceCache = {};
    saveStoreImmediate(persistedStore);
    const syncedAt = new Date().toISOString();
    broadcast('dashboard:synced', { syncedAt });
    res.json({ cleared: true, syncedAt });
  });

  // Pause or resume campaign on Aimfox
  app.patch('/api/aimfox/campaigns/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { state } = req.body as { state?: string };
      if (state !== 'ACTIVE' && state !== 'PAUSED') {
        res.status(400).json({ error: 'state must be ACTIVE or PAUSED' });
        return;
      }

      const result = await aimfoxFetchRaw<Record<string, unknown>>(
        `/api/v2/campaigns/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ state }),
        },
      );

      delete persistedStore.resourceCache['campaigns:list'];
      delete persistedStore.resourceCache[`campaign:${id}:detail`];
      saveStoreImmediate(persistedStore);
      broadcast('campaign:updated', { campaignId: id, state });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update campaign';
      res.status(502).json({ error: message });
    }
  });

  // Search leads via Aimfox (cached per query for 60s to save tokens!)
  app.post('/api/aimfox/leads/search', async (req: Request, res: Response) => {
    try {
      const query = String(req.body?.query || '').trim();
      const count = Math.min(Number(req.body?.count || 25), 50);
      const cacheKey = `leads:search:${query.toLowerCase()}:${count}`;
      const existing = persistedStore.resourceCache[cacheKey] as
        | CachedEntry<{ leads: unknown[] }>
        | undefined;
      if (existing && Date.now() - existing.cachedAt < 60_000) {
        persistedStore.tokensSaved += 1;
        res.setHeader('X-Cache', 'HIT');
        res.json(existing.data);
        return;
      }

      const bodyPayload: Record<string, unknown> = { count };
      if (query) {
        bodyPayload.keywords = query;
      }
      const data = await aimfoxFetchRaw<{ leads: unknown[] }>('/api/v2/leads:search', {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      });
      persistedStore.resourceCache[cacheKey] = { cachedAt: Date.now(), data };
      scheduleSaveStore(persistedStore);
      res.setHeader('X-Cache', 'MISS');
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
      const { data } = await fetchCachedResource<Record<string, unknown>>(
        `conversation:${urn}:${accountId}`,
        endpoint,
        TTL.CONVERSATIONS,
      );
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch conversation';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/aimfox/webhooks', async (_req: Request, res: Response) => {
    try {
      const { data } = await fetchCachedResource<{ webhooks: AimfoxWebhookConfig[] }>(
        'webhooks:v3',
        '/api/v3/webhooks',
        TTL.WEBHOOKS,
      );
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

      const data = await aimfoxFetchRaw<Record<string, unknown>>('/api/v3/webhooks', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      delete persistedStore.resourceCache['webhooks:v3'];
      saveStoreImmediate(persistedStore);
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
      const data = await aimfoxFetchRaw<Record<string, unknown>>(
        `/api/v3/webhooks/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      delete persistedStore.resourceCache['webhooks:v3'];
      saveStoreImmediate(persistedStore);
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
    saveStoreImmediate(persistedStore);
    broadcast('webhooks:cleared', {});
    res.json({ cleared: true });
  });

  app.get('/api/export/csv', async (req: Request, res: Response) => {
    try {
      const rawRange = String(req.query.range || '30d');
      const range: TimeRange = rawRange === '7d' || rawRange === '90d' ? rawRange : '30d';
      const accountId = String(req.query.accountId || 'all');
      const campaignId = String(req.query.campaignId || 'all');

      const { from, to } = getRangeBounds(range);
      const queryParts = [`from=${from}`, `to=${to}`, `bucket=${encodeURIComponent('1 day')}`];
      if (accountId !== 'all') {
        queryParts.push(`account_ids=${encodeURIComponent(JSON.stringify([accountId]))}`);
      }
      if (campaignId !== 'all') queryParts.push(`campaign_id=${encodeURIComponent(campaignId)}`);

      const { data } = await fetchCachedResource<{ buckets: InteractionBucket[] }>(
        `interactions:${range}:${accountId}:${campaignId}`,
        `/api/v2/analytics/interactions?${queryParts.join('&')}`,
        TTL.INTERACTIONS,
        false,
        { buckets: [] },
      );

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

      const rows = (data.buckets || []).map((b) => {
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
        `attachment; filename="aimfox-baby-george-creative-${range}.csv"`,
      );
      res.send([header, ...rows].join('\n'));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed';
      res.status(500).json({ error: message });
    }
  });

  return app;
}
