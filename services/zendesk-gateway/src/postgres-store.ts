import pg from "pg";
import type { ZendeskPendingChoiceSet, ZendeskResolvedChoice } from "@wordless/sdk/zendesk";

import { OutboxPersistenceAfterExecutionError, type GatewayStore } from "./store.js";
import type {
  ChoiceResolutionInput,
  ClaimResult,
  DeliveryClaim,
  InboxItem,
  OutboxItem,
  StageDeliveryInput,
  QuarantineResolutionInput,
  QuarantineRecord,
  CleanupCounts,
  EventClaimResult,
  EventClaimInput,
} from "./types.js";

const { Pool } = pg;

function conversationLockKey(installationId: string, conversationId: string): string {
  return JSON.stringify([installationId, conversationId]);
}

interface InboxRow {
  readonly body_sha256: string;
}

interface ChoiceRow {
  readonly app_id: string;
  readonly conversation_id: string;
  readonly user_id: string;
  readonly suggestion_id: string;
  readonly source_message_id: string;
  readonly source_message_nonce: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly choice_id: string;
  readonly detector_id: string | null;
  readonly reply: string;
  readonly feedback: "confirmed" | "none" | "skip";
}

interface OutboxRow {
  readonly id: string;
  readonly installation_id: string;
  readonly event_key: string;
  readonly operation_kind: "post_message" | "pass_control" | "release_control";
  readonly product_mode: "customer_clarify";
  readonly conversation_id: string;
  readonly guard_event_id: string | null;
  readonly request_json: OutboxItem["request"];
  readonly attempt_count: number;
}

export class PostgresGatewayStore implements GatewayStore {
  private readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly faultInjection: {
      readonly afterFencedExternalDelivery?: () => Promise<void>;
    } = {},
  ) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "wordless-zendesk-gateway",
    });
  }

  async ping(): Promise<void> {
    // A network-only ping can advertise readiness while workers fail on an old schema.
    // Resolve every runtime-critical table/column and require the full migration set.
    await this.pool.query(
      `SELECT inbox.installation_id,
              choice.source_message_nonce,
              claim.owner_delivery_key,
              state.latest_customer_event_id,
              outbox.operator_retry_remaining,
              quarantine.operation_kind,
              quarantine.event_key,
              quarantine.guard_event_id,
              quarantine.zendesk_delivery_key,
              quarantine.zendesk_first_message_id,
              quarantine.handoff_reason,
              quarantine.zendesk_release_key
         FROM wordless_gateway_inbox AS inbox
         CROSS JOIN wordless_gateway_choice_state AS choice
         CROSS JOIN wordless_gateway_event_claims AS claim
         CROSS JOIN wordless_gateway_conversation_state AS state
         CROSS JOIN wordless_gateway_outbox AS outbox
         CROSS JOIN wordless_gateway_conversation_quarantine AS quarantine
        LIMIT 0`,
    );
    const migrations = await this.pool.query<{ applied: number }>(
      `SELECT count(*)::integer AS applied
         FROM wordless_gateway_migrations
        WHERE name = ANY($1::text[])`,
      [["001_gateway.sql", "002_operator_retry_grant.sql", "003_quarantine_correlation.sql"]],
    );
    if (migrations.rows[0]?.applied !== 3) throw new Error("Gateway database schema is not current.");
  }

  async claimDelivery(input: DeliveryClaim): Promise<ClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO wordless_gateway_inbox
           (installation_id, delivery_key, body_sha256, payload_json, status)
         VALUES ($1, $2, $3, $4::jsonb, 'pending')
         ON CONFLICT DO NOTHING
         RETURNING delivery_key`,
        [input.installationId, input.deliveryKey, input.bodySha256, JSON.stringify(input.payload)],
      );
      if (inserted.rowCount === 1) {
        await client.query("COMMIT");
        return "claimed";
      }
      const existing = await client.query<InboxRow>(
        `SELECT body_sha256
           FROM wordless_gateway_inbox
          WHERE installation_id = $1 AND delivery_key = $2
          FOR UPDATE`,
        [input.installationId, input.deliveryKey],
      );
      const row = existing.rows[0];
      if (row === undefined) throw new Error("Inbox conflict disappeared.");
      if (row.body_sha256 !== input.bodySha256) {
        await client.query("ROLLBACK");
        return "conflict";
      }
      await client.query("COMMIT");
      return "duplicate";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimInbox(limit: number, leaseMs: number, maxAttempts: number): Promise<readonly InboxItem[]> {
    const client = await this.pool.connect();
    let result: pg.QueryResult<{
      installation_id: string;
      delivery_key: string;
      payload_json: unknown;
      attempt_count: number;
    }>;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE wordless_gateway_inbox
            SET status = CASE WHEN attempt_count >= $1 THEN 'dead' ELSE 'retry' END,
                lease_until = NULL,
                next_attempt_at = now(),
                payload_json = CASE WHEN attempt_count >= $1 THEN NULL ELSE payload_json END,
                completed_at = CASE WHEN attempt_count >= $1 THEN now() ELSE completed_at END,
                last_error_code = CASE WHEN attempt_count >= $1 THEN 'attempts_exhausted' ELSE 'lease_expired' END
          WHERE status = 'leased' AND lease_until <= now()`,
        [maxAttempts],
      );
      await client.query(
        `UPDATE wordless_gateway_inbox
            SET status = 'dead', payload_json = NULL, completed_at = now(), last_error_code = 'attempts_exhausted'
          WHERE status IN ('pending', 'retry') AND attempt_count >= $1`,
        [maxAttempts],
      );
      result = await client.query<{
        installation_id: string;
        delivery_key: string;
        payload_json: unknown;
        attempt_count: number;
      }>(
      `WITH due AS (
         SELECT installation_id, delivery_key
           FROM wordless_gateway_inbox
          WHERE payload_json IS NOT NULL AND attempt_count < $3
            AND (((status = 'pending' OR status = 'retry') AND next_attempt_at <= now())
              OR (status = 'leased' AND lease_until <= now()))
          ORDER BY next_attempt_at, received_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE wordless_gateway_inbox AS inbox
          SET status = 'leased', attempt_count = attempt_count + 1,
              lease_until = now() + ($2 * interval '1 millisecond')
         FROM due
        WHERE inbox.installation_id = due.installation_id AND inbox.delivery_key = due.delivery_key
       RETURNING inbox.installation_id, inbox.delivery_key, inbox.payload_json, inbox.attempt_count`,
      [limit, leaseMs, maxAttempts],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return result.rows.map((row) => ({
      installationId: row.installation_id,
      deliveryKey: row.delivery_key,
      payload: row.payload_json,
      attemptCount: row.attempt_count,
    }));
  }

  async renewDelivery(installationId: string, deliveryKey: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE wordless_gateway_inbox
          SET lease_until = now() + ($3 * interval '1 millisecond')
        WHERE installation_id = $1 AND delivery_key = $2
          AND status = 'leased' AND lease_until > now()`,
      [installationId, deliveryKey, leaseMs],
    );
    return result.rowCount === 1;
  }

  async claimEvent(input: EventClaimInput): Promise<EventClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (input.controlActivity && input.conversationId !== null) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationLockKey(input.installationId, input.conversationId)]);
      }
      const inserted = await client.query(
        `INSERT INTO wordless_gateway_event_claims
           (installation_id, event_id, owner_delivery_key, status, lease_until)
         VALUES ($1, $2, $3, 'leased', now() + ($4 * interval '1 millisecond'))
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [input.installationId, input.eventId, input.deliveryKey, input.leaseMs],
      );
      if (inserted.rowCount === 1) {
        if (input.controlActivity && input.conversationId !== null) {
          const advanced = await this.advanceConversation(client, input.installationId, input.conversationId, input.eventId, input.eventCreatedAt);
          if (!advanced) {
            await client.query("COMMIT");
            return "stale";
          }
          await this.replaceWithSafetyRelease(client, input);
        }
        await client.query("COMMIT");
        return "claimed";
      }
      const existing = await client.query<{ status: "leased" | "retry" | "completed"; expired: boolean }>(
        `SELECT status, COALESCE(lease_until <= now(), true) AS expired
           FROM wordless_gateway_event_claims
          WHERE installation_id = $1 AND event_id = $2
          FOR UPDATE`,
        [input.installationId, input.eventId],
      );
      const row = existing.rows[0];
      if (row === undefined) throw new Error("Event claim conflict disappeared.");
      if (row.status === "completed") {
        await client.query("COMMIT");
        return "completed";
      }
      if (row.status === "leased" && !row.expired) {
        await client.query("COMMIT");
        return "busy";
      }
      await client.query(
        `UPDATE wordless_gateway_event_claims
            SET owner_delivery_key = $3, status = 'leased',
                lease_until = now() + ($4 * interval '1 millisecond')
          WHERE installation_id = $1 AND event_id = $2`,
        [input.installationId, input.eventId, input.deliveryKey, input.leaseMs],
      );
      if (input.controlActivity && input.conversationId !== null) {
        const advanced = await this.advanceConversation(client, input.installationId, input.conversationId, input.eventId, input.eventCreatedAt);
        if (!advanced) {
          await client.query("COMMIT");
          return "stale";
        }
        await this.replaceWithSafetyRelease(client, input);
      }
      await client.query("COMMIT");
      return "claimed";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async advanceConversation(
    client: pg.PoolClient,
    installationId: string,
    conversationId: string,
    eventId: string,
    occurredAt: string,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO wordless_gateway_conversation_state
         (installation_id, conversation_id, latest_customer_event_id, latest_customer_event_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (installation_id, conversation_id) DO UPDATE SET
         latest_customer_event_id = EXCLUDED.latest_customer_event_id,
         latest_customer_event_at = EXCLUDED.latest_customer_event_at,
         updated_at = now()
       WHERE wordless_gateway_conversation_state.latest_customer_event_at < EXCLUDED.latest_customer_event_at
          OR (wordless_gateway_conversation_state.latest_customer_event_at = EXCLUDED.latest_customer_event_at
              AND wordless_gateway_conversation_state.latest_customer_event_id = EXCLUDED.latest_customer_event_id)
       RETURNING latest_customer_event_id`,
      [installationId, conversationId, eventId, occurredAt],
    );
    return result.rowCount === 1;
  }

  private async replaceWithSafetyRelease(client: pg.PoolClient, input: EventClaimInput): Promise<void> {
    const operation = input.safetyRelease;
    if (operation === null || input.conversationId === null) return;
    const schedulingStartedAt = new Date();
    await client.query(
        `UPDATE wordless_gateway_outbox
          SET status = 'dead', lease_until = NULL, last_error_code = 'release_superseded_by_activity'
        WHERE installation_id = $1 AND operation_kind = 'release_control'
          AND conversation_id = $2 AND event_key <> $3
          AND status IN ('pending', 'retry', 'leased')`,
      [input.installationId, input.conversationId, operation.eventKey],
    );
    await client.query(
      `INSERT INTO wordless_gateway_outbox
         (id, installation_id, event_key, operation_kind, product_mode, conversation_id,
          guard_event_id, request_json, next_attempt_at)
       VALUES ($1::uuid, $2, $3, 'release_control', $4, $5, $6, $7::jsonb,
               CASE WHEN $8::timestamptz <= $9::timestamptz THEN now() ELSE $8::timestamptz END)
       ON CONFLICT (installation_id, event_key) DO UPDATE SET
         guard_event_id = EXCLUDED.guard_event_id,
         request_json = EXCLUDED.request_json,
         next_attempt_at = EXCLUDED.next_attempt_at,
         status = 'pending',
         attempt_count = 0,
         operator_retry_remaining = 0,
         lease_until = NULL,
         last_error_code = NULL
       WHERE wordless_gateway_outbox.status IN ('pending', 'retry', 'dead')`,
      [operation.id, input.installationId, operation.eventKey, operation.productMode,
        operation.conversationId, operation.guardEventId, JSON.stringify(operation.request),
        operation.availableAt, schedulingStartedAt],
    );
  }

  async releaseEvent(installationId: string, eventId: string, deliveryKey: string): Promise<void> {
    await this.pool.query(
      `UPDATE wordless_gateway_event_claims
          SET status = 'retry', lease_until = NULL
        WHERE installation_id = $1 AND event_id = $2
          AND owner_delivery_key = $3 AND status = 'leased'`,
      [installationId, eventId, deliveryKey],
    );
  }

  async stageDelivery(input: StageDeliveryInput): Promise<number> {
    // Application and database clocks can differ by a few milliseconds. Treat
    // timestamps that were already due when staging began as database `now()`;
    // otherwise an immediate message can be invisible until the DB clock catches up.
    // Future absolute deadlines remain unchanged.
    const stagingStartedAt = new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const conversationIds = [...new Set(input.plans.flatMap((plan) =>
        plan.activity === null ? [] : [plan.activity.conversationId]))].sort();
      for (const conversationId of conversationIds) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationLockKey(input.installationId, conversationId)]);
      }
      for (const plan of input.plans) {
        if (plan.activity === null) continue;
        if (plan.eventId === null) throw new Error("Conversation activity requires a claimed event.");
        await this.advanceConversation(
          client,
          input.installationId,
          plan.activity.conversationId,
          plan.eventId,
          plan.activity.occurredAt,
        );
      }
      let queued = 0;
      for (const plan of input.plans) {
        let accepted = true;
        if (plan.activity !== null) {
          if (plan.eventId === null) throw new Error("Conversation activity requires a claimed event.");
          const current = await client.query<{ current: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM wordless_gateway_conversation_state
                WHERE installation_id = $1 AND conversation_id = $2
                  AND latest_customer_event_id = $3
             ) AS current`,
            [input.installationId, plan.activity.conversationId, plan.eventId],
          );
          accepted = current.rows[0]?.current === true;
        }
        if (!accepted) continue;
        if (plan.activity?.cancelReleases === true) {
          await client.query(
            `UPDATE wordless_gateway_outbox
                SET status = 'dead', lease_until = NULL, last_error_code = 'release_superseded'
              WHERE installation_id = $1 AND operation_kind = 'release_control'
                AND conversation_id = $2 AND status IN ('pending', 'retry', 'leased')`,
            [input.installationId, plan.activity.conversationId],
          );
        }
        await this.insertChoices(client, input.installationId, plan.choices, input.choiceExpiresAt);
        for (const operation of plan.operations) {
          const result = await client.query(
            `INSERT INTO wordless_gateway_outbox
             (id, installation_id, event_key, operation_kind, product_mode, conversation_id,
              guard_event_id, request_json, next_attempt_at)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb,
                     CASE WHEN $9::timestamptz <= $10::timestamptz THEN now() ELSE $9::timestamptz END)
             ON CONFLICT (installation_id, event_key) DO NOTHING`,
            [operation.id, input.installationId, operation.eventKey, operation.kind, operation.productMode,
              operation.conversationId, operation.guardEventId, JSON.stringify(operation.request),
              operation.availableAt, stagingStartedAt],
          );
          queued += result.rowCount ?? 0;
        }
      }
      const completed = await client.query(
        `UPDATE wordless_gateway_inbox
            SET status = 'completed', completed_at = now(), lease_until = NULL,
                last_error_code = NULL, payload_json = NULL
          WHERE installation_id = $1 AND delivery_key = $2 AND status = 'leased'`,
        [input.installationId, input.deliveryKey],
      );
      if (completed.rowCount !== 1) throw new Error("Claimed delivery could not be completed.");
      for (const eventId of input.plans.flatMap((plan) => plan.eventId === null ? [] : [plan.eventId])) {
        const completedEvent = await client.query(
          `UPDATE wordless_gateway_event_claims
              SET status = 'completed', completed_at = now(), lease_until = NULL
            WHERE installation_id = $1 AND event_id = $2
              AND owner_delivery_key = $3 AND status = 'leased'`,
          [input.installationId, eventId, input.deliveryKey],
        );
        if (completedEvent.rowCount !== 1) throw new Error("Event lease was lost.");
      }
      await client.query("COMMIT");
      return queued;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async rescheduleDelivery(installationId: string, deliveryKey: string, nextAttemptAt: Date, errorCode: string, terminal: boolean): Promise<void> {
    const reschedulingStartedAt = new Date();
    await this.pool.query(
      `UPDATE wordless_gateway_inbox
          SET status = $3, lease_until = NULL,
              next_attempt_at = CASE WHEN $4::timestamptz <= $6::timestamptz THEN now() ELSE $4::timestamptz END,
              last_error_code = $5, payload_json = CASE WHEN $3 = 'dead' THEN NULL ELSE payload_json END,
              completed_at = CASE WHEN $3 = 'dead' THEN now() ELSE completed_at END
        WHERE installation_id = $1 AND delivery_key = $2 AND status = 'leased'`,
      [installationId, deliveryKey, terminal ? "dead" : "retry", nextAttemptAt, errorCode, reschedulingStartedAt],
    );
  }

  async saveChoices(installationId: string, values: readonly ZendeskPendingChoiceSet[], expiresAt: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.insertChoices(client, installationId, values, expiresAt);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertChoices(
    client: pg.PoolClient,
    installationId: string,
    values: readonly ZendeskPendingChoiceSet[],
    expiresAt: Date,
  ): Promise<void> {
    for (const value of values) {
      for (const choice of value.choices) {
        await client.query(
          `INSERT INTO wordless_gateway_choice_state
             (installation_id, app_id, conversation_id, user_id, payload, suggestion_id,
              source_message_id, source_message_nonce, issued_at,
              choice_id, detector_id, reply, feedback, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (installation_id, payload) DO UPDATE SET
             app_id = EXCLUDED.app_id,
             conversation_id = EXCLUDED.conversation_id,
             user_id = EXCLUDED.user_id,
             suggestion_id = EXCLUDED.suggestion_id,
             source_message_id = EXCLUDED.source_message_id,
             source_message_nonce = EXCLUDED.source_message_nonce,
             issued_at = EXCLUDED.issued_at,
             choice_id = EXCLUDED.choice_id,
             detector_id = EXCLUDED.detector_id,
             reply = EXCLUDED.reply,
             feedback = EXCLUDED.feedback,
             expires_at = EXCLUDED.expires_at`,
          [installationId, value.appId, value.conversationId, value.userId, choice.payload,
            value.suggestionId, value.sourceMessageId, value.sourceMessageNonce, value.issuedAt,
            choice.id, choice.detectorId, choice.reply, choice.feedback,
            new Date(Math.min(expiresAt.getTime(), Date.parse(value.expiresAt)))],
        );
      }
    }
  }

  async resolveChoice(installationId: string, input: ChoiceResolutionInput): Promise<ZendeskResolvedChoice | null> {
    const result = await this.pool.query<ChoiceRow>(
      `UPDATE wordless_gateway_choice_state
          SET consumed_by_event_id = COALESCE(consumed_by_event_id, $6),
              consumed_at = COALESCE(consumed_at, now())
        WHERE installation_id = $1 AND payload = $2 AND app_id = $3
          AND conversation_id = $4 AND user_id = $5 AND expires_at > now()
          AND source_message_nonce = $7 AND issued_at = $8 AND expires_at = $9
          AND $10::timestamptz <= expires_at
          AND (consumed_by_event_id IS NULL OR consumed_by_event_id = $6)
       RETURNING app_id, conversation_id, user_id, suggestion_id, source_message_id,
                 source_message_nonce, issued_at, expires_at, choice_id, detector_id, reply, feedback`,
      [installationId, input.payload, input.appId, input.conversationId, input.userId,
        input.selectionEventId, input.sourceMessageNonce, input.issuedAt, input.expiresAt,
        input.selectionReceivedAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : {
      appId: row.app_id,
      conversationId: row.conversation_id,
      userId: row.user_id,
      suggestionId: row.suggestion_id,
      sourceMessageId: row.source_message_id,
      sourceMessageNonce: row.source_message_nonce,
      issuedAt: row.issued_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      selectionEventId: input.selectionEventId,
      choiceId: row.choice_id,
      detectorId: row.detector_id,
      reply: row.reply,
      feedback: row.feedback,
    };
  }

  async claimOutbox(limit: number, leaseMs: number, maxAttempts: number): Promise<readonly OutboxItem[]> {
    const client = await this.pool.connect();
    let result: pg.QueryResult<OutboxRow>;
    try {
      await client.query("BEGIN");
      // Transition and persist the marker atomically. The UPDATE row lock prevents a
      // concurrent in-flight sender from being falsely quarantined after it commits.
      await client.query(
        `WITH expired AS (
           UPDATE wordless_gateway_outbox
              SET status = 'ambiguous', lease_until = NULL,
                  last_error_code = 'lease_expired_after_send'
            WHERE status = 'leased' AND lease_until <= now()
          RETURNING installation_id, conversation_id, id, operation_kind, event_key,
                    guard_event_id, request_json
         )
         INSERT INTO wordless_gateway_conversation_quarantine
           (installation_id, conversation_id, outbox_id, reason_code,
            operation_kind, event_key, guard_event_id, zendesk_delivery_key,
            zendesk_first_message_id, handoff_reason, zendesk_release_key)
         SELECT installation_id, conversation_id, id, 'lease_expired_after_send',
                operation_kind, event_key, guard_event_id,
                request_json #>> '{body,metadata,wordless_delivery_key}',
                request_json #>> '{body,metadata,first_message_id}',
                request_json #>> '{body,metadata,handoff_reason}',
                request_json #>> '{body,metadata,wordless_release_key}'
           FROM expired
         ON CONFLICT DO NOTHING`,
      );
      await client.query(
        `UPDATE wordless_gateway_outbox
            SET status = 'dead', last_error_code = 'attempts_exhausted'
          WHERE status IN ('pending', 'retry') AND attempt_count >= $1
            AND operator_retry_remaining = 0`,
        [maxAttempts],
      );
      result = await client.query<OutboxRow>(
        `WITH eligible AS (
           SELECT candidate.id, candidate.installation_id, candidate.conversation_id,
                  candidate.next_attempt_at, candidate.sequence_no,
                  CASE
                    WHEN candidate.operation_kind = 'release_control'
                     AND candidate.guard_event_id = state.latest_customer_event_id THEN 0
                    WHEN candidate.operation_kind = 'pass_control'
                     AND candidate.guard_event_id = state.latest_customer_event_id
                     AND candidate.request_json #>> '{body,metadata,handoff_reason}' = 'human_requested'
                     AND candidate.request_json #>> '{body,switchboardIntegration}' <> 'next' THEN 0
                    WHEN candidate.operation_kind = 'release_control' THEN 1
                    ELSE 2
                  END AS priority
             FROM wordless_gateway_outbox AS candidate
             LEFT JOIN wordless_gateway_conversation_state AS state
               ON state.installation_id = candidate.installation_id
              AND state.conversation_id = candidate.conversation_id
            WHERE (candidate.attempt_count < $3 OR candidate.operator_retry_remaining = 1)
              AND candidate.status IN ('pending', 'retry')
              AND candidate.next_attempt_at <= now()
              AND (candidate.operation_kind = 'release_control' OR (
                candidate.operation_kind = 'pass_control'
                AND candidate.guard_event_id = state.latest_customer_event_id
                AND candidate.request_json #>> '{body,metadata,handoff_reason}' = 'human_requested'
                AND candidate.request_json #>> '{body,switchboardIntegration}' <> 'next'
              ) OR (
                NOT EXISTS (
                  SELECT 1 FROM wordless_gateway_conversation_quarantine AS quarantine
                   WHERE quarantine.installation_id = candidate.installation_id
                     AND quarantine.conversation_id = candidate.conversation_id
                )
                AND NOT EXISTS (
                SELECT 1 FROM wordless_gateway_outbox AS earlier
                 WHERE earlier.installation_id = candidate.installation_id
                   AND earlier.conversation_id = candidate.conversation_id
                   AND (
                     earlier.status IN ('leased', 'ambiguous')
                     OR (earlier.status IN ('pending', 'retry') AND earlier.next_attempt_at <= now())
                   )
                   AND earlier.sequence_no < candidate.sequence_no
              )))
         ), first_per_conversation AS (
           SELECT DISTINCT ON (installation_id, conversation_id)
                  id, installation_id, conversation_id, next_attempt_at, sequence_no, priority
             FROM eligible
            ORDER BY installation_id, conversation_id, priority, next_attempt_at, sequence_no
         ), due AS (
           SELECT candidate.id
             FROM wordless_gateway_outbox AS candidate
             JOIN first_per_conversation AS first ON first.id = candidate.id
            ORDER BY first.priority, first.next_attempt_at, first.sequence_no
            FOR UPDATE OF candidate SKIP LOCKED
            LIMIT $1
         )
         UPDATE wordless_gateway_outbox AS outbox
            SET status = 'leased', attempt_count = attempt_count + 1,
                operator_retry_remaining = 0,
                lease_until = now() + ($2 * interval '1 millisecond')
           FROM due
          WHERE outbox.id = due.id
         RETURNING outbox.id::text, outbox.installation_id, outbox.event_key,
                   outbox.operation_kind, outbox.product_mode, outbox.conversation_id,
                   outbox.guard_event_id, outbox.request_json, outbox.attempt_count`,
        [limit, leaseMs, maxAttempts],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return result.rows.map((row) => ({
      id: row.id,
      installationId: row.installation_id,
      eventKey: row.event_key,
      kind: row.operation_kind,
      productMode: row.product_mode,
      conversationId: row.conversation_id,
      availableAt: new Date(),
      guardEventId: row.guard_event_id,
      request: row.request_json,
      attemptCount: row.attempt_count,
    }));
  }

  async markOutboxDelivered(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE wordless_gateway_outbox
          SET status = 'sent', sent_at = now(), lease_until = NULL, last_error_code = NULL
        WHERE id = $1::uuid AND status = 'leased'`,
      [id],
    );
  }

  async rescheduleOutbox(id: string, nextAttemptAt: Date, errorCode: string, terminal: boolean): Promise<void> {
    const reschedulingStartedAt = new Date();
    await this.pool.query(
      `UPDATE wordless_gateway_outbox
          SET status = $2,
              next_attempt_at = CASE WHEN $3::timestamptz <= $5::timestamptz THEN now() ELSE $3::timestamptz END,
              lease_until = NULL, last_error_code = $4
        WHERE id = $1::uuid AND status = 'leased'`,
      [id, terminal ? "dead" : "retry", nextAttemptAt, errorCode, reschedulingStartedAt],
    );
  }

  async markOutboxAmbiguous(id: string, errorCode: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ installation_id: string; conversation_id: string }>(
        `UPDATE wordless_gateway_outbox
            SET status = 'ambiguous', lease_until = NULL, last_error_code = $2
          WHERE id = $1::uuid AND status = 'leased'
        RETURNING installation_id, conversation_id`,
        [id, errorCode],
      );
      const row = updated.rows[0];
      if (row !== undefined) {
        await client.query(
          `INSERT INTO wordless_gateway_conversation_quarantine
             (installation_id, conversation_id, outbox_id, reason_code,
              operation_kind, event_key, guard_event_id, zendesk_delivery_key,
              zendesk_first_message_id, handoff_reason, zendesk_release_key)
           SELECT installation_id, conversation_id, id, $2,
                  operation_kind, event_key, guard_event_id,
                  request_json #>> '{body,metadata,wordless_delivery_key}',
                  request_json #>> '{body,metadata,first_message_id}',
                  request_json #>> '{body,metadata,handoff_reason}',
                  request_json #>> '{body,metadata,wordless_release_key}'
             FROM wordless_gateway_outbox
            WHERE id = $1::uuid
           ON CONFLICT DO NOTHING`,
          [id, errorCode],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileQuarantine(input: QuarantineResolutionInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationLockKey(input.installationId, input.conversationId)]);
      const marker = await client.query(
        `SELECT 1 FROM wordless_gateway_conversation_quarantine
          WHERE installation_id = $1 AND conversation_id = $2 AND outbox_id = $3::uuid
          FOR UPDATE`,
        [input.installationId, input.conversationId, input.outboxId],
      );
      if (marker.rowCount !== 1) throw new Error("Quarantined delivery was not found.");
      const outbox = await client.query<{ status: string }>(
        `SELECT status FROM wordless_gateway_outbox
          WHERE id = $1::uuid AND installation_id = $2 AND conversation_id = $3
          FOR UPDATE`,
        [input.outboxId, input.installationId, input.conversationId],
      );
      const row = outbox.rows[0];
      if (row !== undefined && row.status !== "ambiguous") {
        throw new Error("Quarantined delivery is no longer ambiguous.");
      }
      if (input.resolution === "retry") {
        if (row === undefined) throw new Error("Quarantined payload has expired and cannot be retried.");
        await client.query(
          `UPDATE wordless_gateway_outbox
              SET status = 'retry', next_attempt_at = now(), lease_until = NULL,
                  attempt_count = 100, operator_retry_remaining = 1,
                  last_error_code = 'operator_verified_absent'
            WHERE id = $1::uuid`,
          [input.outboxId],
        );
      } else if (row !== undefined) {
        await client.query(
          `UPDATE wordless_gateway_outbox
              SET status = 'sent', sent_at = now(), lease_until = NULL,
                  last_error_code = 'operator_verified_delivered'
            WHERE id = $1::uuid`,
          [input.outboxId],
        );
      }
      await client.query(
        `DELETE FROM wordless_gateway_conversation_quarantine
          WHERE installation_id = $1 AND conversation_id = $2 AND outbox_id = $3::uuid`,
        [input.installationId, input.conversationId, input.outboxId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listQuarantines(filter: { readonly installationId?: string; readonly conversationId?: string } = {}): Promise<readonly QuarantineRecord[]> {
    const result = await this.pool.query<{
      installation_id: string;
      conversation_id: string;
      outbox_id: string;
      reason_code: string;
      created_at: Date;
      payload_available: boolean;
      operation_kind: "post_message" | "pass_control" | "release_control" | null;
      event_key: string | null;
      guard_event_id: string | null;
      zendesk_delivery_key: string | null;
      zendesk_first_message_id: string | null;
      handoff_reason: string | null;
      zendesk_release_key: string | null;
    }>(
      `SELECT quarantine.installation_id, quarantine.conversation_id,
              quarantine.outbox_id::text, quarantine.reason_code, quarantine.created_at,
              (outbox.id IS NOT NULL) AS payload_available,
              quarantine.operation_kind, quarantine.event_key, quarantine.guard_event_id,
              quarantine.zendesk_delivery_key, quarantine.zendesk_first_message_id,
              quarantine.handoff_reason, quarantine.zendesk_release_key
         FROM wordless_gateway_conversation_quarantine AS quarantine
         LEFT JOIN wordless_gateway_outbox AS outbox ON outbox.id = quarantine.outbox_id
        WHERE ($1::text IS NULL OR quarantine.installation_id = $1)
          AND ($2::text IS NULL OR quarantine.conversation_id = $2)
        ORDER BY quarantine.created_at, quarantine.outbox_id`,
      [filter.installationId ?? null, filter.conversationId ?? null],
    );
    return result.rows.map((row) => ({
      installationId: row.installation_id,
      conversationId: row.conversation_id,
      outboxId: row.outbox_id,
      reasonCode: row.reason_code,
      createdAt: row.created_at.toISOString(),
      payloadAvailable: row.payload_available,
      operationKind: row.operation_kind,
      eventKey: row.event_key,
      guardEventId: row.guard_event_id,
      zendeskDeliveryKey: row.zendesk_delivery_key,
      zendeskFirstMessageId: row.zendesk_first_message_id,
      handoffReason: row.handoff_reason,
      zendeskReleaseKey: row.zendesk_release_key,
    }));
  }

  async deliverOutboxFenced(
    item: OutboxItem,
    execute: () => Promise<"delivered" | "ownership_lost">,
  ): Promise<"delivered" | "ownership_lost" | "stale"> {
    const client = await this.pool.connect();
    let externallyDelivered = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationLockKey(item.installationId, item.conversationId)]);
      const current = await client.query<{ status: string; guard_event_id: string | null; latest_customer_event_id: string | null }>(
        `SELECT outbox.status, outbox.guard_event_id, state.latest_customer_event_id
           FROM wordless_gateway_outbox AS outbox
           LEFT JOIN wordless_gateway_conversation_state AS state
             ON state.installation_id = outbox.installation_id
            AND state.conversation_id = outbox.conversation_id
          WHERE outbox.id = $1::uuid
          FOR UPDATE OF outbox`,
        [item.id],
      );
      const row = current.rows[0];
      if (row?.status !== "leased" || row.guard_event_id === null || row.guard_event_id !== row.latest_customer_event_id) {
        if (row?.status === "leased") {
          await client.query(
            "UPDATE wordless_gateway_outbox SET status = 'dead', lease_until = NULL, last_error_code = 'guard_stale' WHERE id = $1::uuid",
            [item.id],
          );
        }
        await client.query("COMMIT");
        return "stale";
      }
      const outcome = await execute();
      externallyDelivered = outcome === "delivered";
      await this.faultInjection.afterFencedExternalDelivery?.();
      await client.query(
        `UPDATE wordless_gateway_outbox
            SET status = 'sent', sent_at = now(), lease_until = NULL, last_error_code = NULL
          WHERE id = $1::uuid AND status = 'leased'`,
        [item.id],
      );
      await client.query("COMMIT");
      return outcome;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (externallyDelivered) {
        throw new OutboxPersistenceAfterExecutionError({ cause: error });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanup(retentionBefore: Date): Promise<CleanupCounts> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const choices = await client.query("DELETE FROM wordless_gateway_choice_state WHERE expires_at <= now()");
      const events = await client.query(
        "DELETE FROM wordless_gateway_event_claims WHERE status = 'completed' AND completed_at < $1",
        [retentionBefore],
      );
      const outbox = await client.query(
        "DELETE FROM wordless_gateway_outbox WHERE status IN ('sent', 'dead', 'ambiguous') AND created_at < $1",
        [retentionBefore],
      );
      const inbox = await client.query(
        "DELETE FROM wordless_gateway_inbox WHERE status IN ('completed', 'dead') AND COALESCE(completed_at, received_at) < $1",
        [retentionBefore],
      );
      const conversations = await client.query(
        `DELETE FROM wordless_gateway_conversation_state AS state
          WHERE state.updated_at < $1
            AND NOT EXISTS (
              SELECT 1 FROM wordless_gateway_outbox AS outbox
               WHERE outbox.installation_id = state.installation_id
                 AND outbox.conversation_id = state.conversation_id
                 AND outbox.status IN ('pending', 'retry', 'leased', 'ambiguous')
            )
            AND NOT EXISTS (
              SELECT 1 FROM wordless_gateway_conversation_quarantine AS quarantine
               WHERE quarantine.installation_id = state.installation_id
                 AND quarantine.conversation_id = state.conversation_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM wordless_gateway_event_claims AS claim
               WHERE claim.installation_id = state.installation_id
                 AND claim.event_id = state.latest_customer_event_id
                 AND claim.status <> 'completed'
            )`,
        [retentionBefore],
      );
      await client.query("COMMIT");
      return {
        inbox: inbox.rowCount ?? 0,
        outbox: outbox.rowCount ?? 0,
        choices: choices.rowCount ?? 0,
        events: events.rowCount ?? 0,
        conversations: conversations.rowCount ?? 0,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async purgeInstallation(installationId: string): Promise<void> {
    await this.pool.query("SELECT wordless_gateway_purge_installation($1)", [installationId]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
