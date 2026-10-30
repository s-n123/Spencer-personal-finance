"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ThreadItem, ThreadResponse } from "@/server/channels/simulator/handlers";
import { normalizeSimPhone, SIM_PHONES } from "../phones";
import { isHeic, MAX_UPLOAD_BYTES, newMessageId, prepareUpload, splitIntoPosts } from "./upload";

// iMessage-style dev thread. It polls the server's view of the conversation every second, so what
// it shows is exactly what the pipeline stored and sent (no optimistic bubbles).

interface Draft {
  key: string;
  file: File;
  preview: string | null;
}

/** One request; a send is one or more of them (big photo selections are split). */
interface PostPart {
  providerMessageId: string;
  text: string;
  files: File[];
}

interface Post {
  phone: string;
  parts: PostPart[];
}

interface PostResult {
  accepted: number;
  duplicates: number;
  providerMessageId: string;
}

const POLL_MS = 1_000;
/** A centered timestamp separates bubbles more than this far apart, like Messages does. */
const SEPARATOR_GAP_MS = 10 * 60_000;

const ERROR_LABELS: Record<string, string> = {
  phone_not_fictional: "That number isn't a fictional simulator number.",
  text_too_long: "That message is too long.",
  too_many_files: "Too many photos in one message.",
  file_too_large: "A photo is over 8 MB, even after downscaling.",
  request_too_large: "That upload is too big for one request.",
  unsupported_type: "Only images (including HEIC) can be attached.",
  empty_message: "Type a message or attach a photo.",
  unavailable: "The server couldn't take that right now (database down?). Try Resend.",
};

async function postPart(phone: string, part: PostPart): Promise<PostResult> {
  const form = new FormData();
  form.set("phone", phone);
  if (part.text) form.set("text", part.text);
  form.set("providerMessageId", part.providerMessageId);
  form.set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);
  for (const file of part.files) form.append("files", file, file.name);
  const res = await fetch("/api/dev/sim/messages", { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as (Partial<PostResult> & { error?: string }) | null;
  if (!res.ok || !body) {
    const code = body?.error ?? `http_${res.status}`;
    throw new Error(ERROR_LABELS[code] ?? `Send failed (${code}).`);
  }
  return body as PostResult;
}

/** Posts the parts in order (photos first, the text last, as Messages sends them). */
async function postAll(post: Post): Promise<{ accepted: number; duplicates: number }> {
  let accepted = 0;
  let duplicates = 0;
  for (const part of post.parts) {
    const r = await postPart(post.phone, part);
    accepted += r.accepted;
    duplicates += r.duplicates;
  }
  return { accepted, duplicates };
}

export function SimChat({ initialPhone }: { initialPhone: string }) {
  const [phone, setPhone] = useState(initialPhone);
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [last, setLast] = useState<Post | null>(null);
  const [customPhone, setCustomPhone] = useState("");
  const [refresh, setRefresh] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight: AbortController | null = null;
    const load = async () => {
      if (inFlight) return;
      const controller = new AbortController();
      inFlight = controller;
      try {
        const res = await fetch(`/api/dev/sim/thread?phone=${encodeURIComponent(phone)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`thread ${res.status}`);
        const data = (await res.json()) as ThreadResponse;
        if (!cancelled && data.phone === phone) {
          setThread(data);
          setOffline(false);
        }
      } catch {
        if (!cancelled && !controller.signal.aborted) setOffline(true);
      } finally {
        inFlight = null;
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      inFlight?.abort();
    };
  }, [phone, refresh]);

  const itemCount = thread?.items.length ?? 0;
  const typing = thread?.typing ?? false;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [itemCount, typing, phone]);

  function switchPhone(next: string) {
    if (next === phone) return;
    setPhone(next);
    setThread(null);
    setError(null);
    setNotice(null);
    window.history.replaceState(null, "", `?phone=${encodeURIComponent(next)}`);
  }

  function onCustomPhone(e: FormEvent) {
    e.preventDefault();
    const next = normalizeSimPhone(customPhone);
    if (!next) {
      setError("Use a number from +1 201 555-0100 to -0199.");
      return;
    }
    setCustomPhone("");
    switchPhone(next);
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const added = Array.from(list, (file) => ({
      key: newMessageId(),
      file,
      // Most browsers can't render HEIC; show a chip instead of a broken image.
      preview: isHeic(file) ? null : URL.createObjectURL(file),
    }));
    setDrafts((d) => [...d, ...added]);
    if (fileRef.current) fileRef.current.value = "";
  }

  function removeDraft(key: string) {
    setDrafts((d) => {
      const gone = d.find((x) => x.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return d.filter((x) => x.key !== key);
    });
  }

  async function send() {
    const body = text.trim();
    if (busy || (!body && drafts.length === 0)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const files = await Promise.all(drafts.map((d) => prepareUpload(d.file)));
      const tooBig = files.find((f) => f.size > MAX_UPLOAD_BYTES);
      if (tooBig) throw new Error(ERROR_LABELS.file_too_large);
      const groups = splitIntoPosts(files);
      const post: Post = {
        phone,
        parts: groups.map((g, i) => ({
          providerMessageId: newMessageId(),
          files: g,
          text: i === groups.length - 1 ? body : "",
        })),
      };
      // Remembered before sending, so a partly failed send can be completed with Resend.
      setLast(post);
      await postAll(post);
      setText("");
      for (const d of drafts) if (d.preview) URL.revokeObjectURL(d.preview);
      setDrafts([]);
      setRefresh((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (busy || !last) return;
    setBusy(true);
    setError(null);
    try {
      const result = await postAll(last);
      setNotice(
        `Resent the last message (same id) to ${last.phone}: ${result.duplicates} duplicate part(s) ignored, ${result.accepted} new.`,
      );
      setRefresh((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resend failed.");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (busy || !window.confirm("Delete every simulator user, message and photo?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dev/sim/reset", { method: "POST" });
      if (!res.ok) throw new Error(`Reset failed (${res.status}).`);
      const result = (await res.json()) as { users: number; blobs: number };
      setNotice(`Reset: removed ${result.users} user(s) and ${result.blobs} stored file(s).`);
      setLast(null);
      setThread(null);
      setRefresh((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed.");
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const items = thread?.items ?? [];
  const lastInboundId = [...items].reverse().find((i) => i.dir === "in")?.id;

  return (
    <div className="mx-auto flex h-dvh w-full max-w-xl flex-col bg-white text-neutral-900 dark:bg-black dark:text-neutral-100">
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="mr-auto">
          <div className="text-sm font-semibold">Coach</div>
          <div className="text-xs text-neutral-500">Simulator · dev only · fictional numbers</div>
        </div>
        <label className="sr-only" htmlFor="sim-phone">
          Your number
        </label>
        <select
          id="sim-phone"
          className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          value={SIM_PHONES.includes(phone) ? phone : ""}
          onChange={(e) => switchPhone(e.target.value)}
        >
          {SIM_PHONES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <form onSubmit={onCustomPhone} className="flex gap-1">
          <input
            aria-label="Custom number (0100 to 0199)"
            className="w-24 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            placeholder="0142"
            value={customPhone}
            onChange={(e) => setCustomPhone(e.target.value)}
          />
          <button type="submit" className="rounded-md px-2 py-1 text-sm text-blue-600 hover:bg-blue-50 dark:hover:bg-neutral-900">
            Go
          </button>
        </form>
        <button
          type="button"
          onClick={() => void reset()}
          disabled={busy}
          className="rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-neutral-900"
        >
          Reset
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4" aria-live="polite">
        {thread === null && !offline && <p className="text-center text-xs text-neutral-500">Loading…</p>}
        {thread !== null && items.length === 0 && (
          <p className="mt-8 text-center text-sm text-neutral-500">
            No messages yet for {phone}. Say hi or send a meal photo.
          </p>
        )}
        {items.map((item, i) => (
          <Row
            key={item.id}
            item={item}
            prev={items[i - 1]}
            next={items[i + 1]}
            showReceipt={item.id === lastInboundId}
          />
        ))}
        {thread?.typing && <TypingDots />}
      </div>

      {(error || notice || offline) && (
        <div className="space-y-1 px-4 pb-1 text-xs">
          {offline && <p className="text-amber-600">Can&apos;t reach the dev server; retrying…</p>}
          {error && <p className="text-red-600">{error}</p>}
          {notice && <p className="text-neutral-500">{notice}</p>}
        </div>
      )}

      {drafts.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-4 pb-2">
          {drafts.map((d) => (
            <div key={d.key} className="relative shrink-0">
              {d.preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                <img src={d.preview} alt="" className="h-16 w-16 rounded-lg object-cover" />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-neutral-200 text-xs dark:bg-neutral-800">
                  HEIC
                </div>
              )}
              <button
                type="button"
                aria-label="Remove photo"
                onClick={() => removeDraft(d.key)}
                className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-neutral-700 text-xs leading-5 text-white"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        className="flex items-end gap-2 border-t border-neutral-200 px-3 py-3 dark:border-neutral-800"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <button
          type="button"
          aria-label="Attach photos"
          onClick={() => fileRef.current?.click()}
          className="h-9 w-9 shrink-0 rounded-full bg-neutral-200 text-lg leading-9 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
        >
          +
        </button>
        <textarea
          aria-label="Message"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="iMessage"
          className="max-h-32 min-h-9 flex-1 resize-none rounded-2xl border border-neutral-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700"
        />
        <button
          type="submit"
          disabled={busy || (!text.trim() && drafts.length === 0)}
          className="h-9 shrink-0 rounded-full bg-blue-500 px-3 text-sm font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
        <button
          type="button"
          onClick={() => void resend()}
          disabled={busy || !last}
          title="Re-post the previous message with the same provider message id (dedupe demo)"
          className="h-9 shrink-0 rounded-full px-2 text-xs text-blue-600 disabled:opacity-40"
        >
          Resend last
        </button>
      </form>
    </div>
  );
}

function formatSeparator(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function inboundReceipt(status: string): string {
  if (status === "pending") return "Delivered";
  if (status === "failed") return "Not processed";
  return "Read";
}

const OUTBOUND_NOTES: Record<string, string> = {
  intent: "Sending…",
  sending: "Sending…",
  suppressed: "Not sent (messaging paused)",
  unknown: "Delivery unknown",
  undeliverable: "Undeliverable",
  failed: "Failed to send",
};

function Row({
  item,
  prev,
  next,
  showReceipt,
}: {
  item: ThreadItem;
  prev: ThreadItem | undefined;
  next: ThreadItem | undefined;
  showReceipt: boolean;
}) {
  const at = new Date(item.at).getTime();
  const separator = !prev || at - new Date(prev.at).getTime() > SEPARATOR_GAP_MS;
  const groupEnd = !next || next.dir !== item.dir;
  const mine = item.dir === "in";

  return (
    <>
      {separator && <p className="my-3 text-center text-[11px] text-neutral-500">{formatSeparator(item.at)}</p>}
      <div className={`flex flex-col ${mine ? "items-end" : "items-start"} ${groupEnd ? "mb-2" : "mb-0.5"}`}>
        {item.dir === "in" &&
          item.media.map((m) => (
            <div key={m.id} className="mb-0.5">
              {m.status === "stored" ? (
                // eslint-disable-next-line @next/next/no-img-element -- private, no-store dev route
                <img
                  src={`/api/dev/sim/media/${m.id}`}
                  alt="Your photo"
                  className="max-h-64 max-w-64 rounded-2xl object-cover"
                />
              ) : (
                <div className="flex h-32 w-40 items-center justify-center rounded-2xl bg-neutral-200 text-xs text-neutral-500 dark:bg-neutral-800">
                  {m.status === "failed" || m.status === "purged" ? "Photo unavailable" : "Processing photo…"}
                </div>
              )}
            </div>
          ))}
        {(item.text !== null || (item.dir === "in" && item.media.length === 0)) && (
          <div
            title={new Date(item.at).toLocaleString()}
            className={`max-w-[75%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[15px] leading-snug ${
              mine
                ? "bg-blue-500 text-white"
                : "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
            }`}
          >
            {item.text ?? <span className="italic opacity-80">(text not stored)</span>}
          </div>
        )}
        {item.dir === "in" && item.tag && (
          <span className="mt-0.5 text-[10px] uppercase tracking-wide text-neutral-500">screen: {item.tag}</span>
        )}
        {item.dir === "out" && (item.status !== "sent" || item.kind !== "reply") && (
          <span className="mt-0.5 text-[10px] text-neutral-500">
            {[item.kind !== "reply" ? item.kind : null, item.status !== "sent" ? OUTBOUND_NOTES[item.status] ?? item.status : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
        {showReceipt && item.dir === "in" && (
          <span className="mt-0.5 text-[10px] text-neutral-500">{inboundReceipt(item.status)}</span>
        )}
      </div>
    </>
  );
}

function TypingDots() {
  return (
    <div className="mb-2 flex items-start" aria-label="Coach is typing">
      <div className="flex gap-1 rounded-2xl bg-neutral-200 px-3 py-2.5 dark:bg-neutral-800">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="h-2 w-2 animate-bounce rounded-full bg-neutral-500"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
