// Desktop client for the Sparkle support ticketing system (docs/support/SUPPORT-SYSTEM-SPEC.md §7).
// Thin JS surface over the Rust `support::*` Tauri commands (which do the HTTP + log tailing +
// secret redaction + keychain bearer in Rust, off the webview). Every call goes through `invoke`
// so it can be mocked at the module boundary in tests. The pure payload-assembly helpers
// (`deriveSubject`, `buildTicketPayload`) live here so they unit-test without any IO.

import { invoke } from "@tauri-apps/api/core";

/** One turn of the support chat, matching the web `/api/support/chat` contract. */
export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

/** A documentation link the assistant surfaced; opened in the system browser as a chip. */
export interface DocLink {
  title: string;
  href: string;
}

/** Reply from the docs-aware chat helper. */
export interface ChatResp {
  reply: string;
  docLinks: DocLink[];
  offerTicket: boolean;
}

/** App/environment metadata attached to every ticket. */
export interface SupportMeta {
  appVersion: string;
  os: string;
  arch: string;
}

/** One stored chat turn to persist with the ticket (`{role, body}`, matching lib/support.ts). */
export interface TranscriptMsg {
  role: string;
  body: string;
}

/** The payload the Rust `desktop_create_ticket` command expects (camelCase → serde). */
export interface CreateTicketPayload {
  email: string;
  subject: string;
  message: string;
  appVersion?: string;
  os?: string;
  metadata?: Record<string, unknown>;
  logs?: string;
  assistantTranscript?: TranscriptMsg[];
}

/** The created ticket: its id, capability token, and the secret URL to view/reply. */
export interface CreatedTicket {
  id: string;
  token: string;
  url: string;
}

/** One of the signed-in user's tickets, as surfaced to the sidebar status banner. `status` is the
 *  reused DB status; an OPEN ticket is one whose status !== "resolved". */
export interface TicketStatus {
  id: string;
  token: string;
  subject: string;
  status: "awaiting_support" | "awaiting_user" | "resolved";
  lastMessageAt?: string;
}

/** Dispatched on `window` after a ticket is created so the sidebar status banner refetches
 *  immediately instead of waiting for its 60s poll. */
export const TICKET_CREATED_EVENT = "sparkle:ticket-created";

// ── Command wrappers ────────────────────────────────────────────────────────────────────────────

/** Tail the unified log (current + most recent rotated), redacted of secrets, capped at ~200 KB. */
export function readRecentLogs(): Promise<string> {
  return invoke<string>("read_recent_logs");
}

/** App version + host OS/arch. */
export function supportMetadata(): Promise<SupportMeta> {
  return invoke<SupportMeta>("support_metadata");
}

/** Send the running transcript to the docs-aware helper and get the reply + doc links. */
export function supportChatSend(messages: ChatMsg[]): Promise<ChatResp> {
  return invoke<ChatResp>("support_chat_send", { messages });
}

/** Create a support ticket (attaches the keychain bearer in Rust if the user is signed in). */
export function desktopCreateTicket(payload: CreateTicketPayload): Promise<CreatedTicket> {
  return invoke<CreatedTicket>("desktop_create_ticket", { payload });
}

/** List the signed-in user's own support tickets. Returns [] when signed out (Rust short-circuits
 *  without a network call). */
export function listMyTickets(): Promise<TicketStatus[]> {
  return invoke<TicketStatus[]>("desktop_list_tickets");
}

/** Reduce the user's tickets to the single sidebar banner state, or null when there is nothing to
 *  show. An OPEN ticket is an ACTIVE one (`awaiting_support` or `awaiting_user`); `openTickets` are
 *  those, in input order. Defined as an allow-list of the two active states (rather than "not
 *  resolved") so any future terminal status the backend adds — `closed`, `archived`, … — correctly
 *  defaults to hidden instead of pinning the banner open. The banner reflects the
 *  most-attention-needing open ticket: if ANY open ticket is `awaiting_user` (support replied,
 *  waiting on the user) the banner is "Responded" + alert; else it's "Submitted" (waiting on
 *  support) with no alert. Pure — unit-tested, no IO. */
export function bannerFromTickets(
  tickets: TicketStatus[],
): { label: "Submitted" | "Responded"; alert: boolean; openTickets: TicketStatus[] } | null {
  const openTickets = tickets.filter(
    (t) => t.status === "awaiting_support" || t.status === "awaiting_user",
  );
  if (openTickets.length === 0) return null;
  const alert = openTickets.some((t) => t.status === "awaiting_user");
  return { label: alert ? "Responded" : "Submitted", alert, openTickets };
}

// ── Pure payload assembly (unit-tested) ───────────────────────────────────────────────────────

/** Derive a concise ticket subject from the user's first message (first line, ≤80 chars). Falls
 *  back to a friendly default when the user opened a ticket without typing anything. */
export function deriveSubject(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim();
  if (!trimmed) return "Sparkle desktop support request";
  const firstLine = (trimmed.split("\n")[0] ?? trimmed).trim();
  // Slice by code points (Array.from), not UTF-16 units, so a surrogate pair (emoji) at the 80-char
  // boundary isn't split into a mojibake half before the ellipsis.
  const chars = Array.from(firstLine);
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : firstLine;
}

/** Assemble the full ticket payload from the chat transcript, gathered logs, metadata, and email.
 *  Subject/message derive from the first USER turn; the whole transcript is persisted so the ticket
 *  carries the in-app conversation. Pure — no IO — so it unit-tests without Tauri. */
export function buildTicketPayload(args: {
  email: string;
  transcript: ChatMsg[];
  logs: string;
  meta: SupportMeta;
}): CreateTicketPayload {
  const firstUser = args.transcript.find((m) => m.role === "user")?.content ?? "";
  return {
    email: args.email.trim(),
    subject: deriveSubject(firstUser),
    message: firstUser || "(Opened a support ticket from the Sparkle desktop app.)",
    appVersion: args.meta.appVersion,
    os: args.meta.os,
    metadata: { arch: args.meta.arch },
    logs: args.logs,
    assistantTranscript: args.transcript.map((m) => ({ role: m.role, body: m.content })),
  };
}
