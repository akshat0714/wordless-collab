# Dedicated Zendesk pilot deployment

This package runs one contracted Zendesk Messaging pilot behind public HTTPS.
Only Caddy publishes host ports. The Zendesk gateway, Wordless API, and
PostgreSQL have no public port mappings. PostgreSQL holds the durable webhook
inbox, one-time choices, event claims, release jobs, and outbox; the Wordless
volume holds its SQLite decision record and model cache.

This is the deployable dedicated-pilot boundary, not a self-service Zendesk
Marketplace installer. Start in a Zendesk Sandbox and complete the acceptance
gates before connecting a production brand.

## External prerequisites

Before running the bootstrap, obtain or complete all of the following:

- A Linux Docker host with Docker Engine and the Compose v2 plugin, persistent
  encrypted storage, outbound HTTPS, and enough memory for the pinned sentence
  embedding model. Use `docker compose version` to confirm the plugin.
- A dedicated Wordless Git checkout whose repository root is this project's
  root, with a reviewed commit and no modified or untracked files. A parent
  directory's unrelated Git repository is not valid release provenance.
- A lowercase public DNS name whose A/AAAA records point to the host. Inbound
  TCP 80/443 and UDP 443 must reach it so Caddy can obtain a certificate.
- An upstream managed edge, firewall, or load balancer with customer-approved
  volumetric denial-of-service protection plus request-rate, connection, and
  request-body limits. The bounded Node request reader and Caddy timeouts are
  application safeguards; they are not volumetric attack protection.
- Zendesk Messaging in a Sandbox, a Sunshine Conversations v2 custom
  integration, and a dedicated **integration-scoped** key id/secret. Never use
  an app-scoped key with the `next` Switchboard target.
- The Zendesk app id, webhook id, generated webhook `X-API-Key` secret,
  Wordless `activeSwitchboardIntegration.id` (the Switchboard entry id),
  `activeSwitchboardIntegration.integrationId` (the underlying integration id).
  These two integration ids are not interchangeable.
- The separate Agent Workspace Switchboard entry `.id` used for direct human
  requests. It must differ from the Wordless entry. Configure the customer's
  normal bot as Wordless's `next` target and `deliverStandbyEvents: false`;
  keep the normal bot's tested escalation route as well.
- A customer-operated HTTPS evidence resolver implementing the contract below.
- An English-only locale policy. By default the gateway requires an
  authenticated Zendesk `profile.locale` beginning with `en`; missing and
  non-English locales yield to the normal bot without calling the evidence
  resolver. The dedicated production pilot does not permit a missing-locale
  exception.
- A labeled customer Sandbox evaluation that supplies the threshold and a
  non-placeholder threshold-version identifier. The example value is not a
  production calibration.
- An encrypted backup target, monitoring/alerting, incident contacts, retention
  approval, and the customer's security/privacy approval.

The root-context gateway build expects
`services/zendesk-gateway/Dockerfile`. The Wordless API build uses the existing
`deploy/wordless-api/Dockerfile`. Do not continue if either image cannot be
built and scanned in your release process.

## Sandbox-first bootstrap

Run from this directory. All command-line values are non-secret. The script
prompts through `getpass` for the Zendesk integration key id, key secret, and
Zendesk-generated webhook secret, so they do not enter shell history or the
process argument list.

```sh
cd /path/to/Wordless/deploy/zendesk

python3 bootstrap.py \
  --public-domain wordless-sandbox.example.com \
  --installation-id acme_sandbox \
  --zendesk-subdomain acme-sandbox \
  --zendesk-app-id APP_ID_FROM_ZENDESK \
  --zendesk-webhook-id WEBHOOK_ID_FROM_ZENDESK \
  --zendesk-switchboard-integration-id SWITCHBOARD_ENTRY_ID \
  --zendesk-underlying-integration-id UNDERLYING_INTEGRATION_ID \
  --zendesk-human-switchboard-integration-id AGENT_WORKSPACE_SWITCHBOARD_ENTRY_ID \
  --evidence-resolver-url https://support-api.example.com/wordless/evidence \
  --threshold 1.6 \
  --threshold-version acme-sandbox-eval-2026-07-30
```

The bootstrap refuses to overwrite `.env.production` or `secrets/`. It creates
the directory with mode `0700` and every generated file with mode `0600`.
`.env.production` contains only non-secret settings. Secret values live in
individual files mounted at `/run/secrets`; installation JSON contains secret
references, never credential values. Do not add either generated path to Git.

The exact webhook target printed by the script is:

```text
https://PUBLIC_DOMAIN/v1/webhooks/zendesk/INSTALLATION_ID
```

For the example above it is:

```text
https://wordless-sandbox.example.com/v1/webhooks/zendesk/acme_sandbox
```

Configure one v2 webhook with that target, the generated Zendesk webhook secret,
and all five subscriptions: `conversation:message`, `conversation:create`,
`conversation:referral`, `switchboard:passControl`, and
`switchboard:releaseControl`. A missing or wrong `X-API-Key`, wrong app/webhook
id, business-authored event, and event where Wordless is not active all fail
closed.

For `conversation:create` with `creationReason: proactiveMessaging`, this pilot
does **not** greet. It remains silent unless a customer-specific campaign policy
inspection is implemented, security-reviewed, and accepted in the Sandbox.

## Switchboard coverage boundary

For this sidecar deployment, set the Wordless Switchboard entry `.id` as the
global default responder and remove or update any channel-level
`defaultResponder` override that points somewhere else. Set Wordless
`nextSwitchboardIntegrationId` to the existing normal-bot entry; keep the
normal bot's existing human escalation route. The normal bot must call
`releaseControl` when its interaction is resolved so the next neutral/new
interaction is assigned to the then-current default responder.

This makes Wordless the accessible **front door** to each interaction. It does
not make Wordless an invisible observer of every later turn: Zendesk suppresses
`conversation:message` events for standby integrations when
`deliverStandbyEvents` is false, and `passControl` makes the target bot active
immediately. Do not advertise the Switchboard sidecar as per-message coverage
after handoff.

If the requirement is to evaluate every English-language customer message
before the existing bot replies, embed `@wordless/sdk/server` in that bot's
inbound-message handler; that is the true every-message topology. For mid-flow
opt-in with a separate bot, the active bot must recognize the exact
`wordless:show_choices:v1` reply payload and use integration-scoped credentials
to pass control directly to the Wordless Switchboard entry `.id` (never its
underlying `.integrationId`). This return route is a required customer
integration and Sandbox acceptance case; a transcript button alone cannot
change which integration is active.

Review the non-secret settings, then validate and start the complete stack:

```sh
docker compose --env-file .env.production -f compose.yaml config --quiet
docker compose --env-file .env.production -f compose.yaml up --build -d
```

The second command builds both application images, starts PostgreSQL, waits for
it to become healthy, applies migrations once under an advisory lock, warms the
private Wordless API, starts the gateway only after both dependencies are
healthy, and finally starts Caddy. No manual migration command is needed.

First model startup may take several minutes and requires outbound HTTPS. The
production image uses PyTorch's pinned CPU-only wheel; no CUDA runtime or GPU is
required. Hugging Face and embedding caches persist in
`wordless-zendesk-wordless-data`, the only writable application volume, and are
owned by runtime uid/gid `10001`. Preserve that ownership when restoring the
volume. After the exact model is cached and a restart has succeeded, an
operator may set `WORDLESS_OFFLINE=true` in `.env.production` to prevent
runtime model fetching.

Check status without printing secrets:

```sh
docker compose --env-file .env.production -f compose.yaml ps
docker compose --env-file .env.production -f compose.yaml logs --tail=100 migrate
docker compose --env-file .env.production -f compose.yaml logs --tail=100 zendesk-gateway
curl --fail --silent --show-error https://wordless-sandbox.example.com/health/ready
```

Then run the credential-safe Sandbox smoke check:

```sh
python3 smoke.py --confirm-sandbox
```

The script reads the webhook key from its generated `0600` file, verifies TLS,
liveness, readiness, fail-closed missing/wrong credentials, the configured
`X-API-Key`, and rejection of malformed JSON. It never accepts a credential on
the command line, never prints a credential or response body, and never submits
a valid customer event. A pass proves ingress/authentication wiring only; run
the full acceptance cases below before production.

If this Docker installation exposes the standalone `docker-compose` command
instead of the plugin, substitute `docker-compose` in the commands unchanged.

## Evidence resolver contract

The gateway first fetches the Zendesk user through authenticated Conversations
API credentials and requires `authenticated: true`. Only then does it call the
customer resolver. The resolver secret is generated at
`secrets/evidence_resolver_shared_secret`; transfer it through the customer's
approved secret channel and mount it in the resolver. Never email or log it.

The gateway sends an HTTPS `POST` with `Content-Type: application/json` and a
bounded body:

```json
{
  "schema_version": 1,
  "installation_id": "acme_sandbox",
  "zendesk_app_id": "APP_ID_FROM_ZENDESK",
  "zendesk_identity": {
    "type": "external_id",
    "value": "authenticated-stable-id"
  },
  "zendesk_conversation_id": "conversation-id",
  "zendesk_message_id": "message-id",
  "message_received_at": "2026-07-30T20:00:00Z"
}
```

If no authenticated `externalId` exists, `zendesk_identity.type` is `user_id`
and its value is the authenticated Zendesk user id. The resolver must use this
typed, verified identity; it must never derive an account from message text,
display name, or email typed into chat.

The authentication headers are:

```text
X-Wordless-Resolver-Timestamp: UNIX_SECONDS
X-Wordless-Resolver-Signature: v1=LOWERCASE_HEX_HMAC_SHA256
```

Verify the timestamp within the agreed replay window, then compute HMAC-SHA256
over the exact UTF-8 bytes `TIMESTAMP + "." + RAW_BODY` using the shared secret
and compare in constant time. Reject a stale timestamp, altered body, or reused
request according to the resolver's replay policy.

Return `404` or this response when no verified customer mapping exists:

```json
{ "authenticated": false }
```

For an authenticated mapping, return:

```json
{
  "authenticated": true,
  "installation_id": "acme_sandbox",
  "zendesk_identity": {
    "type": "external_id",
    "value": "authenticated-stable-id"
  },
  "customer_id": "internal-stable-customer-id",
  "observed_at": "2026-07-30T20:00:01Z",
  "evidence": [],
  "metadata": {}
}
```

The installation and typed identity must exactly echo the request.
`observed_at` must be timezone-aware and cannot precede the customer message.
Return at most 100 current, read-only evidence records using the exported
Wordless evidence contract. Do not return action credentials, unbounded account
history, raw payment data, or facts from another tenant.

## Acceptance before production

Exercise these cases in the Sandbox and retain evidence of the result:

1. A valid event receives a fast `202`; wrong secret, wrong installation,
   duplicate conflict, malformed JSON, and oversized body are rejected.
2. Concurrent retries create one logical inference/outbox operation. A selected
   choice accepts the same event retry but rejects replay by a new event id.
3. Anonymous/cross-account users disclose no evidence and continue safely.
   Missing and non-English profile locales also yield without an evidence
   resolver call.
4. Ordinary questions continue to the existing bot. English fragmented,
   misspelled, and empty turns show the intended support path. Confirm the native
   **I don't know what to say** button is visible without typing and that using
   it opens the same accessible clarification path.
5. Explicit human/person/agent requests bypass inference and reach the tested
   human route.
6. Lost Switchboard ownership suppresses pending sends. Resolved or idle
   interactions execute `releaseControl` before the configured deadline.
7. Resolver, Wordless, database, and Zendesk outages exercise the documented
   retry, dead-letter, or ambiguous-delivery response without duplicate action.
8. Backup restore, rollback, secret rotation, installation purge, retention,
   and alerting are rehearsed.

## Retention and SQLite compaction

`RETENTION_DAYS` is an enforced online retention boundary from 1 through 90
days; the generated deployment uses 30. The Wordless API cleans at startup and
hourly; the gateway cleans hourly. The setting does not mean that every
operational row disappears after that many days:

- The private Wordless SQLite service deletes completed suggestions by
  `completed_at` and abandoned `processing` reservations by `created_at` once
  they cross the boundary. The tenant-keyed rows are deleted transactionally;
  the related redacted interaction, result, suggestion events, and feedback
  are removed together by foreign-key cascade. Pending records inside the
  boundary are preserved.
- The Zendesk gateway deletes completed/dead inbox rows, sent/dead/ambiguous
  outbox rows, and completed event claims after the boundary. Inbox payloads
  are cleared as soon as processing completes or becomes terminal. One-time
  choices instead expire at their shorter `CHOICE_TTL_HOURS` deadline.
- Pending, retrying, or leased work is never removed by scheduled retention.
  An expired conversation ordering fence is removed only when no live or
  ambiguous outbox operation, unresolved quarantine, or unfinished event claim
  still depends on it. An unresolved ambiguous-delivery quarantine remains
  until an operator performs the reconciliation procedure below. That safety
  record can intentionally outlive `RETENTION_DAYS`; include the exception in
  the customer's approved policy and incident process.

Cleanup does not rewrite backups, database snapshots, Zendesk transcripts, or
the customer evidence system. Govern those copies independently. Alert on a
Wordless readiness failure or its `Product retention cleanup failed` log, and
on the gateway's `retention_cleanup_failed` event. Do not claim the retention
objective while cleanup is unhealthy.

Before production, route public readiness failures and the gateway's
`gateway_start_failed`, `inbox_dead`, `outbox_dead`, `outbox_ambiguous`, and
`retention_cleanup_failed` structured events to the customer's monitored alert
channel. Alerting only on process uptime is insufficient. Review unresolved
quarantines after every `outbox_ambiguous` event and at least daily until the
customer establishes a stricter incident SLA.

PostgreSQL cleanup is a logical row deletion. Old values may remain in
PostgreSQL WAL, storage-provider snapshots, replicas, or retained backups until
their separately approved lifecycle expires; routine autovacuum is not an
erasure guarantee. Keep the database volume encrypted and use the database and
backup provider's verified destruction process. Do not run `VACUUM FULL` as an
ad hoc substitute on the live pilot.

SQLite enables `secure_delete` on every application connection, but online
deletion does not shrink the database and is not a promise of forensic erasure
from SSDs, volume snapshots, or backups. During an approved maintenance window,
after taking and verifying the Wordless-volume backup, stop every process that
can open the file and run the repository's checkpoint-and-VACUUM operation.
Allow temporary free space at least twice the current SQLite database size and
do not run this command against a live `wordless-api` container:

```sh
docker compose --env-file .env.production -f compose.yaml stop caddy zendesk-gateway wordless-api
docker compose --env-file .env.production -f compose.yaml run --rm --no-deps \
  --entrypoint python wordless-api -c \
  'from wordless.realtime.repository import RealtimeRepository; RealtimeRepository("/srv/wordless/realtime.sqlite3").compact()'
docker compose --env-file .env.production -f compose.yaml up --no-deps --wait --wait-timeout 300 -d wordless-api
docker compose --env-file .env.production -f compose.yaml up --no-deps --wait --wait-timeout 120 -d zendesk-gateway
docker compose --env-file .env.production -f compose.yaml start caddy
curl --fail --silent --show-error https://wordless-sandbox.example.com/health/ready
```

The compaction command truncates the WAL before rebuilding the database. If it
or either health wait fails, leave Caddy stopped, preserve the database and its
`-wal`/`-shm` companions, and restore or investigate rather than rerunning
destructive maintenance blindly. Encrypted storage, snapshot expiry, and
verified backup destruction remain required for the customer's erasure policy.

## Backup

First prove that this directory is the root of a dedicated, clean Wordless Git
checkout. The check deliberately fails in an untracked copy or a checkout nested
inside an unrelated parent repository. Then record the exact source commit,
resolved Compose configuration hash, and immutable local image ids:

```sh
set -eu
EXPECTED_WORDLESS_ROOT="$(cd ../.. && pwd -P)"
ACTUAL_WORDLESS_ROOT="$(git -C "$EXPECTED_WORDLESS_ROOT" rev-parse --show-toplevel)"
ACTUAL_WORDLESS_ROOT="$(cd "$ACTUAL_WORDLESS_ROOT" && pwd -P)"
if [ "$ACTUAL_WORDLESS_ROOT" != "$EXPECTED_WORDLESS_ROOT" ]; then
  echo "Refusing backup: Wordless is not the root of its own Git checkout." >&2
  exit 1
fi
if [ -n "$(git -C "$EXPECTED_WORDLESS_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "Refusing backup: the Wordless checkout is not clean." >&2
  exit 1
fi

install -d -m 700 backups
date -u +%Y%m%dT%H%M%SZ > backups/backup-id
git -C "$EXPECTED_WORDLESS_ROOT" rev-parse --verify 'HEAD^{commit}' > backups/git-revision
docker compose --env-file .env.production -f compose.yaml config > backups/compose.resolved.yaml
sha256sum backups/compose.resolved.yaml > backups/compose-config.sha256
docker compose --env-file .env.production -f compose.yaml images > backups/images.txt
docker compose --env-file .env.production -f compose.yaml images --quiet \
  | sort -u > backups/image-ids.txt
test -s backups/image-ids.txt
chmod 600 backups/backup-id backups/git-revision backups/compose.resolved.yaml \
  backups/compose-config.sha256 backups/images.txt backups/image-ids.txt
```

`compose.resolved.yaml` contains no secret file contents in this deployment,
but it is still an internal configuration artifact and must remain in the
private backup set. If images are pushed to a registry, record and deploy their
registry digests as well as these local image ids.

Take a consistent PostgreSQL custom-format dump. The password is read inside
the container from its mounted secret file and is never placed on argv:

```sh
umask 077
docker compose --env-file .env.production -f compose.yaml exec -T postgres \
  sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec pg_dump --username wordless_gateway --dbname wordless_gateway --format=custom' \
  > backups/gateway.dump
chmod 600 backups/gateway.dump
```

For the Wordless SQLite database and model cache, take a short maintenance
window and archive the stopped volume:

```sh
umask 077
docker compose --env-file .env.production -f compose.yaml stop zendesk-gateway wordless-api
docker run --rm \
  --mount type=volume,src=wordless-zendesk-wordless-data,dst=/data,readonly \
  --mount type=bind,src="$PWD/backups",dst=/backup \
  alpine:3.23 tar -C /data -czf /backup/wordless-data.tar.gz .
docker compose --env-file .env.production -f compose.yaml start wordless-api zendesk-gateway
chmod 600 backups/wordless-data.tar.gz
```

Back up `.env.production` and `secrets/` only into the organization's encrypted
secret backup system. For example, with an approved `age` recipient:

```sh
umask 077
tar -C . -cf - .env.production secrets \
  | age --recipient AGE_PUBLIC_RECIPIENT --output backups/config.tar.age
chmod 600 backups/config.tar.age
```

Never create an unencrypted secrets archive. Verify dump readability and copy
all artifacts off-host according to the customer's retention policy.

## Restore rehearsal

Restore to a new host or new empty named volumes; do not overwrite the only
running copy. Restore and permission-check the encrypted configuration first,
then create the empty Wordless volume and extract its backup only if empty:

```sh
docker volume create wordless-zendesk-wordless-data
docker run --rm \
  --mount type=volume,src=wordless-zendesk-wordless-data,dst=/data \
  --mount type=bind,src="$PWD/backups",dst=/backup,readonly \
  alpine:3.23 sh -ec 'test -z "$(find /data -mindepth 1 -maxdepth 1 -print -quit)"; tar -C /data -xzf /backup/wordless-data.tar.gz'
```

Start a fresh PostgreSQL volume, wait for health, and restore the dump:

```sh
docker compose --env-file .env.production -f compose.yaml up -d postgres
docker compose --env-file .env.production -f compose.yaml exec -T postgres \
  sh -ec 'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec pg_restore --exit-on-error --clean --if-exists --no-owner --username wordless_gateway --dbname wordless_gateway' \
  < backups/gateway.dump
docker compose --env-file .env.production -f compose.yaml run --rm migrate
docker compose --env-file .env.production -f compose.yaml up -d
```

Confirm health, counts, one-time-choice behavior, and a full Sandbox test before
changing DNS or Zendesk targets. Keep the original deployment untouched until
the restore is accepted.

## Rollback

Before every update, take both backups above and retain the previous immutable
image ids. Migrations are forward-only and checksum-protected.

For an application-only rollback with a compatible schema:

```sh
docker compose --env-file .env.production -f compose.yaml stop caddy zendesk-gateway
# Restore the previously approved source revision or immutable image tags here.
docker compose --env-file .env.production -f compose.yaml up --no-build --no-deps -d zendesk-gateway
docker compose --env-file .env.production -f compose.yaml up --no-build --no-deps -d caddy
```

If the previous application is not compatible with the migrated schema, do not
edit or reverse a recorded migration. Restore the pre-update PostgreSQL dump and
Wordless volume into fresh volumes using the restore procedure, then start the
previous images. Never use `docker compose down -v` during rollback; it deletes
the persistent pilot data.

An outbox item marked `ambiguous` means Zendesk may already have accepted it.
Do not reset or resend it blindly. Reconcile the conversation and its
`wordless_delivery_key` metadata, then record an operator decision. The
quarantine command reads PostgreSQL credentials only through the service's
mounted `DATABASE_URL_FILE`; no credential is accepted on the command line.

List quarantines without message text or request bodies:

```sh
docker compose --env-file .env.production -f compose.yaml run --rm --no-deps \
  zendesk-gateway node dist/reconcile.js list \
  --installation acme_sandbox \
  --conversation CONVERSATION_ID
```

After Zendesk metadata proves the operation was delivered, mark that exact
outbox item delivered and release the conversation quarantine:

```sh
docker compose --env-file .env.production -f compose.yaml run --rm --no-deps \
  zendesk-gateway node dist/reconcile.js resolve \
  --installation acme_sandbox \
  --conversation CONVERSATION_ID \
  --outbox OUTBOX_UUID \
  --resolution delivered \
  --confirmation verified-delivered
```

Only when Zendesk proves the operation is absent and repeating it is safe may
an operator authorize one retry:

```sh
docker compose --env-file .env.production -f compose.yaml run --rm --no-deps \
  zendesk-gateway node dist/reconcile.js resolve \
  --installation acme_sandbox \
  --conversation CONVERSATION_ID \
  --outbox OUTBOX_UUID \
  --resolution retry \
  --confirmation verified-absent-safe-to-retry
```

Keep the command output and the Zendesk verification evidence in the approved
incident/change record. If `payload_available` is false, retry is intentionally
unavailable; only a verified-delivered resolution can remove that retained
quarantine marker.

## Removal and secret handling

Stopping the stack does not remove volumes:

```sh
docker compose --env-file .env.production -f compose.yaml down
```

After the webhook and integration have been disabled in the Zendesk Sandbox,
purge one installation's gateway state with the migration-defined
`wordless_gateway_purge_installation()` function under an approved change. Do
not delete `secrets/` or volumes until retention, legal hold, and verified backup
requirements are satisfied.

Rotate Zendesk credentials, webhook secret, Wordless tenant key/signing secret,
resolver secret, and PostgreSQL password through a planned dual-key or downtime
procedure appropriate to each component. The bootstrap is intentionally not a
rotation tool and will never overwrite existing secrets.
