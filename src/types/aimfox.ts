export type TimeRange = '7d' | '30d' | '90d';

export interface AimfoxAccountLicense {
  status: string;
  lifetime: boolean;
  expires_at: number;
  source: string;
  account_id: string;
}

export interface AimfoxAccountLimits {
  id: number | string;
  agency_id?: string;
  connect: number;
  inmail: number;
  warmup?: {
    enabled: boolean;
  };
}

export interface AimfoxAccount {
  id: string;
  workspace_id: string;
  type: string;
  disabled: boolean;
  urn: string;
  public_identifier: string;
  first_name: string;
  last_name: string;
  full_name: string;
  occupation: string;
  picture_url?: string;
  premium: boolean;
  sales_navigator: boolean;
  state: string;
  license?: AimfoxAccountLicense;
  limits?: AimfoxAccountLimits | null;
}

export interface InteractionBucket {
  timestamp: number;
  sent_connections: number;
  accepted_connections: number;
  sent_messages: number;
  sent_inmails: number;
  replies: number;
  inmail_replies: number;
  views: number;
  message_requests: number;
  sent_likes: number;
  sent_endorsements: number;
}

export interface CampaignMetrics {
  sent_connections: number;
  accepted_connections: number;
  sent_messages: number;
  replies: number;
  inmail_replies: number;
  sent_inmails: number;
  message_requests: number;
  sent_endorsements: number;
  views: number;
  sent_likes: number;
}

export interface AimfoxCampaign {
  id: string;
  list_id?: string;
  name: string;
  state: 'ACTIVE' | 'PAUSED' | string;
  completed: boolean;
  created_at: number;
  outreach_type: string;
  owners: string[];
  target_count: number;
  completion?: number;
  uses_connection_note?: boolean;
  metrics?: CampaignMetrics;
}

export interface RecentLeadEvent {
  timestamp: string;
  account_id: string;
  campaign_id: string;
  target_id: string;
  target_urn: string;
  transition: string;
  campaign_name: string;
  owner: string;
  target: {
    urn: string;
    full_name: string;
    picture_url?: string;
    occupation?: string;
  };
}

export interface AimfoxTemplate {
  id: string;
  name: string;
  type: string;
  message: string;
  created_at: number;
  metrics: {
    sent: number;
    replies: number;
    accepted: number;
  };
}

export interface AimfoxConversationParticipant {
  id: string;
  urn: string;
  public_identifier?: string;
  first_name?: string;
  last_name?: string;
  full_name: string;
  occupation?: string;
  picture_url?: string;
}

export interface AimfoxConversation {
  unread_count: number;
  connected: boolean;
  last_activity_at: number;
  conversation_urn: string;
  last_message?: {
    account_id: number | string;
    urn: string;
    body: string;
    sender: { id: string };
    created_at: number;
  };
  participants: AimfoxConversationParticipant[];
}

export interface AimfoxLead {
  id: string;
  is_lead: boolean;
  replied: boolean;
  favorite: boolean;
  urn: string;
  public_identifier?: string;
  first_name: string;
  last_name: string;
  full_name: string;
  picture_url?: string;
  occupation?: string;
  location?: {
    name: string;
    urn: string;
  };
  origins?: Array<{ id: string; name: string }>;
  labels?: Array<{ id: string; name: string; color?: string }>;
  notes?: Array<{ id: string; text: string; created_at?: number }>;
}

export interface AimfoxWebhookConfig {
  id: string;
  name: string;
  url: string;
  events: string[];
  active?: boolean;
  created_at?: string | number;
}

export interface StoredWebhookEvent {
  id: string;
  event_type: string;
  workspace: string;
  received_at: string;
  is_test?: boolean;
  event: Record<string, unknown>;
}

export interface UserPerformanceRow {
  account: AimfoxAccount;
  totals: CampaignMetrics;
  acceptanceRate: number;
  replyRate: number;
  todayConnections: number;
  todayMessages: number;
  dailyConnectLimit: number;
  dailyInmailLimit: number;
  activeCampaignsCount: number;
  unreadConversationsCount: number;
  buckets: InteractionBucket[];
}

export interface CustomerProfile {
  fullName: string;
  email: string;
  workspaceName: string;
  workspaceId: string;
}

export interface CacheTelemetry {
  hit: boolean;
  staleRevalidating?: boolean;
  ageSeconds: number;
  requestsLastMinute: number;
  limitPerMinute: number;
  tokensSavedEstimate?: number;
}

export interface BasePageResponse {
  customer: CustomerProfile;
  syncedAt: string;
  cache: CacheTelemetry;
  accounts: AimfoxAccount[];
  campaigns: AimfoxCampaign[];
}

export interface OverviewPageResponse extends BasePageResponse {
  range: TimeRange;
  accountId: string;
  campaignId: string;
  buckets: InteractionBucket[];
  totals: CampaignMetrics & {
    acceptanceRate: number;
    replyRate: number;
    totalTargets: number;
    unreadConversations: number;
  };
  userPerformance: UserPerformanceRow[];
  recentLeads: RecentLeadEvent[];
  webhookEvents: StoredWebhookEvent[];
}

export interface UsersPageResponse extends BasePageResponse {
  range: TimeRange;
  userPerformance: UserPerformanceRow[];
}

export interface CampaignsPageResponse extends BasePageResponse {
  templates: AimfoxTemplate[];
}

export interface LeadsPageResponse extends BasePageResponse {
  recentLeads: RecentLeadEvent[];
  conversations: AimfoxConversation[];
}

export interface WebhooksPageResponse extends BasePageResponse {
  webhookEndpointUrl: string;
  webhookSecretConfigured: boolean;
  webhooks: AimfoxWebhookConfig[];
  webhookEvents: StoredWebhookEvent[];
}

export interface DashboardOverviewResponse {
  customer: CustomerProfile;
  range: TimeRange;
  accountId: string;
  campaignId: string;
  syncedAt: string;
  fromCache: boolean;
  rateLimit: {
    requestsLastMinute: number;
    limitPerMinute: number;
  };
  webhookEndpointUrl: string;
  webhookSecretConfigured: boolean;
  accounts: AimfoxAccount[];
  campaigns: AimfoxCampaign[];
  buckets: InteractionBucket[];
  totals: CampaignMetrics & {
    acceptanceRate: number;
    replyRate: number;
    totalTargets: number;
    unreadConversations: number;
  };
  userPerformance: UserPerformanceRow[];
  recentLeads: RecentLeadEvent[];
  templates: AimfoxTemplate[];
  conversations: AimfoxConversation[];
  webhooks: AimfoxWebhookConfig[];
  webhookEvents: StoredWebhookEvent[];
}
