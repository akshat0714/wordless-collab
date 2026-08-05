import type {
  ZendeskApiRequest,
  ZendeskPendingChoiceSet,
  ZendeskTextMessageBody,
  ZendeskPassControlBody,
  ZendeskReleaseControlBody,
} from "@wordless/sdk/zendesk";

export type RuntimeEnvironment = "development" | "test" | "production";
export type StoreDriver = "memory" | "postgres";
export type DeliveryMode = "zendesk" | "log";

export type InstallationAuthentication =
  | {
      readonly type: "basic";
      readonly scope: "integration";
      readonly keyIdRef: string;
      readonly keySecretRef: string;
    }
  | {
      readonly type: "bearer";
      readonly scope: "integration";
      readonly tokenRef: string;
      readonly marketplace?: {
        readonly name: string;
        readonly organizationId: string;
        readonly botId: string;
      };
    };

export interface Installation {
  readonly id: string;
  readonly appId: string;
  readonly webhookId: string;
  readonly switchboardIntegrationId: string;
  readonly underlyingIntegrationId: string;
  /** Direct Agent Workspace/human Switchboard entry; never the normal bot's `next` hop. */
  readonly humanSwitchboardIntegrationId: string;
  readonly zendeskSubdomain: string;
  readonly webhookAuth: {
    readonly mode: "path_bearer" | "hmac_sha256" | "x_api_key";
    readonly secretRef: string;
  };
  readonly choiceSigningSecretRef: string;
  readonly wordlessApiKeyRef: string;
  readonly wordlessSigningSecretRef: string;
  readonly zendeskAuthentication: InstallationAuthentication;
}

export interface GatewayConfig {
  readonly environment: RuntimeEnvironment;
  readonly host: string;
  readonly port: number;
  readonly storeDriver: StoreDriver;
  readonly databaseUrl: string | null;
  readonly wordlessBaseUrl: string;
  readonly installations: ReadonlyMap<string, Installation>;
  readonly evidenceResolver:
    | {
        readonly mode: "http";
        readonly url: string;
        readonly authorizationSecretRef: string;
        readonly timeoutMs: number;
      }
    | {
        readonly mode: "demo";
        readonly evidenceJson: unknown;
      };
  readonly deliveryMode: DeliveryMode;
  readonly productMode: "customer_clarify";
  readonly bodyMaxBytes: number;
  readonly webhookClockSkewSeconds: number;
  readonly processTimeoutMs: number;
  readonly zendeskTimeoutMs: number;
  readonly choiceTtlHours: number;
  readonly supportedLocalePrefixes: readonly string[];
  readonly requireKnownLocale: boolean;
  readonly outboxPollMs: number;
  readonly outboxLeaseMs: number;
  readonly outboxMaxAttempts: number;
  readonly shutdownGraceMs: number;
  readonly retentionDays: number;
  readonly cleanupIntervalMs: number;
}

export interface CleanupCounts {
  readonly inbox: number;
  readonly outbox: number;
  readonly choices: number;
  readonly events: number;
  readonly conversations: number;
}

export interface StagedOperation {
  readonly id: string;
  readonly eventKey: string;
  readonly kind: "post_message" | "pass_control" | "release_control";
  readonly productMode: "customer_clarify";
  readonly conversationId: string;
  readonly availableAt: Date;
  readonly guardEventId: string | null;
  readonly request: ZendeskApiRequest<ZendeskTextMessageBody | ZendeskPassControlBody | ZendeskReleaseControlBody>;
}

export interface OutboxItem extends StagedOperation {
  readonly installationId: string;
  readonly attemptCount: number;
}

export interface DeliveryClaim {
  readonly installationId: string;
  readonly deliveryKey: string;
  readonly bodySha256: string;
  readonly payload: unknown;
}

export interface InboxItem {
  readonly installationId: string;
  readonly deliveryKey: string;
  readonly payload: unknown;
  readonly attemptCount: number;
}

export interface StageDeliveryInput {
  readonly installationId: string;
  readonly deliveryKey: string;
  readonly choiceExpiresAt: Date;
  /** Side effects are grouped by their source event so stale work can be dropped atomically. */
  readonly plans: readonly StageEventPlan[];
}

export interface StageEventPlan {
  /** Null is reserved for installation/operator work that did not claim a webhook event. */
  readonly eventId: string | null;
  readonly activity: {
    readonly conversationId: string;
    readonly occurredAt: string;
    readonly cancelReleases: boolean;
  } | null;
  readonly operations: readonly StagedOperation[];
  readonly choices: readonly ZendeskPendingChoiceSet[];
}

export interface QuarantineResolutionInput {
  readonly installationId: string;
  readonly conversationId: string;
  readonly outboxId: string;
  readonly resolution: "delivered" | "retry";
}

export interface QuarantineRecord {
  readonly installationId: string;
  readonly conversationId: string;
  readonly outboxId: string;
  readonly reasonCode: string;
  readonly createdAt: string;
  readonly payloadAvailable: boolean;
  readonly operationKind: StagedOperation["kind"] | null;
  readonly eventKey: string | null;
  readonly guardEventId: string | null;
  readonly zendeskDeliveryKey: string | null;
  readonly zendeskFirstMessageId: string | null;
  readonly handoffReason: string | null;
  readonly zendeskReleaseKey: string | null;
}

export type ClaimResult = "claimed" | "duplicate" | "conflict";
export type EventClaimResult = "claimed" | "completed" | "busy" | "stale";

export interface EventClaimInput {
  readonly installationId: string;
  readonly eventId: string;
  readonly deliveryKey: string;
  readonly leaseMs: number;
  readonly conversationId: string | null;
  readonly controlActivity: boolean;
  readonly safetyRelease: StagedOperation | null;
  readonly eventCreatedAt: string;
}

export interface ChoiceResolutionInput {
  readonly appId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly payload: string;
  readonly selectionEventId: string;
  readonly selectionReceivedAt: string;
  readonly sourceMessageNonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
