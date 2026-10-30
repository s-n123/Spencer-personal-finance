import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { InboundMessage, NormalizedEvent } from "@/server/channels/types";
import { inboundMessages, media, outboundMessages, users } from "@/server/db/schema";
import { selectRows } from "@/server/db/sql";
import type { Deps } from "@/server/deps";
import { logError } from "@/server/errors";
import { log } from "@/server/log";
import { userPrefix } from "@/server/media/storage/types";
import { handleInboundEvents } from "@/server/pipeline/inbound";
import { isValidTimeZone } from "@/server/time";
import { SIM_INBOX_CONTENT_TYPE, simInboxKey, simInboxPrefix, simInboxUrl } from "./adapter";
import { isCrossSiteRequest, NO_STORE } from "./guard";
import { SIM_UPLOAD_LIMITS } from "./limits";
import { FICTIONAL_E164_PATTERN, isFictionalNumber, parseSimulatorPhone } from "./phone";

// Request handlers behind the /api/dev/sim/* routes. The route files only run the simulator guard
// and resolve deps; everything here takes Deps so tests drive it with PGlite and fakes.

export const SIM_LIMITS = {
  ...SIM_UPLOAD_LIMITS,
  /** Thread window shown by the page. */
  threadRows: 200,
  /** Typing dots expire on their own if no reply follows. */
  typingWindowMs: 60_000,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9-]{8,64}$/;
const HEIC_NAME = /\.(heic|heif)$/i;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function isImageUpload(file: File): boolean {
  return file.type.startsWith("image/") || HEIC_NAME.test(file.name);
}

/**
 * Browsers often send HEIC as "" or application/octet-stream; fall back to the extension so the
 * row records what it was.
 */
function uploadMimeType(file: File): string | undefined {
  if (file.type.startsWith("image/")) return file.type.slice(0, 100);
  return HEIC_NAME.test(file.name) ? "image/heic" : undefined;
}

export interface SimPostResult {
  accepted: number;
  duplicates: number;
  /** Base id for "Resend last": re-posting with it replays the same provider message ids. */
  providerMessageId: string;
}

/**
 * POST /api/dev/sim/messages (multipart: phone, text?, providerMessageId?, timezone?, files[]).
 * One InboundMessage per file plus one for the text, mirroring Sendblue's one webhook per
 * attachment (D-123), so turn batching is exercised in dev.
 */
export async function postSimMessages(deps: Deps, req: Request): Promise<Response> {
  if (isCrossSiteRequest(req)) return json(403, { error: "cross_site" });
  // Checked before parsing: past the proxy's buffer limit the body would arrive truncated.
  if (Number(req.headers.get("content-length") ?? 0) > SIM_LIMITS.maxRequestBytes) {
    return json(413, { error: "request_too_large" });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "bad_form" });
  }

  const phone = parseSimulatorPhone(form.get("phone"));
  if (!phone) return json(400, { error: "phone_not_fictional" });

  const rawText = form.get("text");
  if (rawText !== null && typeof rawText !== "string") return json(400, { error: "bad_text" });
  const text = rawText?.trim() ? rawText.trim() : null;
  if (text && text.length > SIM_LIMITS.maxTextChars) return json(400, { error: "text_too_long" });

  const rawId = form.get("providerMessageId");
  if (rawId !== null && (typeof rawId !== "string" || !CLIENT_MESSAGE_ID.test(rawId))) {
    return json(400, { error: "bad_provider_message_id" });
  }
  const baseId = rawId ?? randomUUID();

  const rawTz = form.get("timezone");
  const timezoneHint = typeof rawTz === "string" && rawTz.length <= 64 && isValidTimeZone(rawTz) ? rawTz : undefined;

  const entries = form.getAll("files");
  if (entries.some((f) => typeof f === "string")) return json(400, { error: "bad_file" });
  const files = entries as File[];
  if (files.length > SIM_LIMITS.maxFilesPerPost) return json(400, { error: "too_many_files" });
  for (const file of files) {
    if (file.size === 0) return json(400, { error: "empty_file" });
    if (file.size > SIM_LIMITS.maxFileBytes) return json(413, { error: "file_too_large" });
    if (!isImageUpload(file)) return json(415, { error: "unsupported_type" });
  }
  if (!text && files.length === 0) return json(400, { error: "empty_message" });

  const parts = [
    ...files.map((file, i) => ({ id: `${baseId}:img${i}`, file })),
    ...(text ? [{ id: `${baseId}:text`, file: null }] : []),
  ];

  try {
    // A resend replays known ids; skip staging their files (ingest answers "duplicate" first).
    const known = await knownMessageIds(deps, parts.map((p) => p.id));
    const now = deps.clock.now().getTime();
    const events: NormalizedEvent[] = [];
    for (const [i, part] of parts.entries()) {
      const mediaRefs: InboundMessage["media"] = [];
      if (part.file && !known.has(part.id)) {
        const uploadId = randomUUID();
        await deps.storage.put(
          simInboxKey(uploadId),
          new Uint8Array(await part.file.arrayBuffer()),
          SIM_INBOX_CONTENT_TYPE,
        );
        mediaRefs.push({ url: simInboxUrl(uploadId), mimeType: uploadMimeType(part.file) });
      }
      events.push({
        kind: "message",
        message: {
          provider: "simulator",
          providerMessageId: part.id,
          fromE164: phone,
          toLine: null,
          text: part.file ? null : text,
          media: mediaRefs,
          // Spaced by 1 ms, ending now, so the parts keep their composer order (photos, then text).
          sentAt: new Date(now - (parts.length - 1 - i)),
          service: "iMessage",
          timezoneHint,
        },
      });
    }
    const summary = await handleInboundEvents(deps, events);
    const result: SimPostResult = { accepted: summary.accepted, duplicates: summary.duplicates, providerMessageId: baseId };
    return json(200, result);
  } catch (err) {
    // Same contract as a provider webhook (D-043): a DB failure is a 503 and the client may resend.
    logError("sim.messages.failed", err, { route: "dev.sim.messages" });
    return json(503, { error: "unavailable" });
  }
}

async function knownMessageIds(deps: Deps, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await deps.db
    .select({ id: inboundMessages.providerMessageId })
    .from(inboundMessages)
    .where(and(eq(inboundMessages.provider, "simulator"), inArray(inboundMessages.providerMessageId, ids)));
  return new Set(rows.map((r) => r.id));
}

export interface ThreadInbound {
  dir: "in";
  id: string;
  at: string;
  text: string | null;
  status: string;
  /** Keyword or crisis tag set by the ingest screen (dev visibility). */
  tag: string | null;
  media: { id: string; status: string }[];
}

export interface ThreadOutbound {
  dir: "out";
  id: string;
  at: string;
  text: string | null;
  status: string;
  kind: string;
}

export type ThreadItem = ThreadInbound | ThreadOutbound;

export interface ThreadResponse {
  phone: string;
  items: ThreadItem[];
  typing: boolean;
}

/** GET /api/dev/sim/thread?phone=... */
export async function getSimThread(deps: Deps, req: Request): Promise<Response> {
  const phone = parseSimulatorPhone(new URL(req.url).searchParams.get("phone"));
  if (!phone) return json(400, { error: "phone_not_fictional" });
  const thread = await loadThread(deps, phone);
  return json(200, thread);
}

export async function loadThread(deps: Deps, phone: string): Promise<ThreadResponse> {
  const [user] = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phoneE164, phone), eq(users.provider, "simulator")));
  if (!user) return { phone, items: [], typing: false };

  const inbound = await deps.db
    .select({
      id: inboundMessages.id,
      text: inboundMessages.text,
      status: inboundMessages.status,
      keyword: inboundMessages.keyword,
      crisisKind: inboundMessages.crisisKind,
      sentAt: inboundMessages.sentAt,
    })
    .from(inboundMessages)
    .where(eq(inboundMessages.userId, user.id))
    .orderBy(desc(inboundMessages.sentAt), desc(inboundMessages.receivedAt))
    .limit(SIM_LIMITS.threadRows);

  const mediaRows =
    inbound.length === 0
      ? []
      : await deps.db
          .select({ id: media.id, inboundMessageId: media.inboundMessageId, status: media.status })
          .from(media)
          .where(
            and(
              eq(media.userId, user.id),
              inArray(
                media.inboundMessageId,
                inbound.map((m) => m.id),
              ),
            ),
          )
          .orderBy(asc(media.createdAt), asc(media.id));
  const mediaByMessage = new Map<string, { id: string; status: string }[]>();
  for (const m of mediaRows) {
    if (!m.inboundMessageId) continue;
    const list = mediaByMessage.get(m.inboundMessageId) ?? [];
    list.push({ id: m.id, status: m.status });
    mediaByMessage.set(m.inboundMessageId, list);
  }

  const outbound = await deps.db
    .select({
      id: outboundMessages.id,
      text: outboundMessages.text,
      status: outboundMessages.status,
      kind: outboundMessages.kind,
      seq: outboundMessages.seq,
      at: sql<unknown>`coalesce(${outboundMessages.sentAt}, ${outboundMessages.createdAt})`,
    })
    .from(outboundMessages)
    .where(eq(outboundMessages.userId, user.id))
    .orderBy(desc(sql`coalesce(${outboundMessages.sentAt}, ${outboundMessages.createdAt})`), desc(outboundMessages.seq))
    .limit(SIM_LIMITS.threadRows);

  const keyed: { item: ThreadItem; key: number; seq: number }[] = [
    ...inbound.map((m) => ({
      item: {
        dir: "in" as const,
        id: m.id,
        at: m.sentAt.toISOString(),
        text: m.text,
        status: m.status,
        tag: m.keyword ?? m.crisisKind,
        media: mediaByMessage.get(m.id) ?? [],
      },
      key: m.sentAt.getTime(),
      seq: 0,
    })),
    ...outbound.map((m) => {
      const at = toDate(m.at);
      return {
        item: { dir: "out" as const, id: m.id, at: at.toISOString(), text: m.text, status: m.status, kind: m.kind },
        key: at.getTime(),
        seq: m.seq,
      };
    }),
  ];
  keyed.sort((a, b) => a.key - b.key || a.seq - b.seq);

  return {
    phone,
    items: keyed.slice(-SIM_LIMITS.threadRows).map((k) => k.item),
    typing: await isTyping(deps, user.id),
  };
}

async function isTyping(deps: Deps, userId: string): Promise<boolean> {
  const [row] = await selectRows<{ started: unknown; stopped: unknown; last_sent: unknown }>(
    deps.db,
    sql`select
          (select max(created_at) from simulator_events where user_id = ${userId} and type = 'typing_start') as started,
          (select max(created_at) from simulator_events where user_id = ${userId} and type = 'typing_stop') as stopped,
          (select max(sent_at) from outbound_messages where user_id = ${userId} and status = 'sent') as last_sent`,
  );
  if (!row || row.started == null) return false;
  const started = toDate(row.started).getTime();
  const after = (v: unknown) => v == null || started > toDate(v).getTime();
  const age = deps.clock.now().getTime() - started;
  return after(row.stopped) && after(row.last_sent) && age >= 0 && age < SIM_LIMITS.typingWindowMs;
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

/** GET /api/dev/sim/media/[id]: the processed JPEG, only for a simulator user's media. */
export async function getSimMedia(deps: Deps, id: string): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404, headers: { ...NO_STORE, "content-type": "text/plain" } });
  if (!UUID.test(id)) return notFound();
  const [row] = await deps.db
    .select({
      storageKey: media.storageKey,
      status: media.status,
      phone: users.phoneE164,
      provider: users.provider,
    })
    .from(media)
    .innerJoin(users, eq(users.id, media.userId))
    .where(eq(media.id, id));
  if (!row || row.provider !== "simulator" || !isFictionalNumber(row.phone)) return notFound();
  if (row.status !== "stored" || !row.storageKey) return notFound();
  const obj = await deps.storage.get(row.storageKey);
  if (!obj) return notFound();
  return new Response(new Uint8Array(obj.bytes), {
    status: 200,
    headers: {
      ...NO_STORE,
      "content-type": "image/jpeg",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    },
  });
}

export interface SimResetResult {
  users: number;
  blobs: number;
}

/** POST /api/dev/sim/reset: removes every simulator user (fictional numbers only) and their blobs. */
export async function resetSimulator(deps: Deps): Promise<SimResetResult> {
  const deleted = await selectRows<{ id: string }>(
    deps.db,
    sql`delete from users where provider = 'simulator' and phone_e164 ~ ${FICTIONAL_E164_PATTERN} returning id`,
  );
  let blobs = 0;
  // Rows first: a download still in flight then finds no row and deletes the blob it wrote.
  for (const { id } of deleted) {
    blobs += await deps.storage.deletePrefix(userPrefix(id));
  }
  blobs += await deps.storage.deletePrefix(simInboxPrefix());
  log.info("sim.reset", { count: deleted.length });
  return { users: deleted.length, blobs };
}

export async function postSimReset(deps: Deps, req: Request): Promise<Response> {
  if (isCrossSiteRequest(req)) return json(403, { error: "cross_site" });
  return json(200, await resetSimulator(deps));
}
