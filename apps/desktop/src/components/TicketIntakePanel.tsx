// TicketIntakePanel — the "paste tickets, fan out" front door (bead `.6`).
//
// A paste box, then one card per parsed reference: the tracker it belongs to, the key, and the
// three derived strings a person is otherwise re-typing by hand (branch, commit prefix, PR title).
// Once fetched, each card also carries the ticket's title, its body, and a thumbnail strip of the
// screenshots that were downloaded WITH it.
//
// ── AMBIGUITY IS SHOWN, NEVER RESOLVED BY THE UI ────────────────────────────────────────────────
// A bare `ENG-1234` is a valid Linear key AND a valid Jira key. The backend refuses to guess, and
// so does this panel: an ambiguous card renders in the caution ink, says "Linear or Jira — pick
// one", and its Fetch button is disabled. Rendering a guess would be worse than rendering nothing,
// because the user would never learn that a choice had been made on their behalf.
//
// ── ONLY AN IMAGE IS PAINTED AS ONE ─────────────────────────────────────────────────────────────
// A ticket can attach a log, a PDF or a zip. Rust refuses to download a non-image at all, so a row
// here should always be one — but the paint still checks `mime`, because an <img> pointed at a text
// file paints a broken glyph on a row marked ok, with a byte count and no reason, which is exactly
// the thing the rest of this header is about.
//
// ── A FAILED IMAGE IS A ROW, NOT AN ABSENCE ─────────────────────────────────────────────────────
// Linear's attachment links expire in about five minutes, so a failed download is this feature's
// EXPECTED failure. The strip therefore renders a placeholder tile for a failed image and the
// summary line counts it — "3 images, 1 could not be fetched". A strip that simply showed two
// thumbnails would report the loss as an absence nobody could notice.
//
// ── A THUMBNAIL IS A `data:` URL, NEVER A `file://` PATH ────────────────────────────────────────
// The webview's CSP is `img-src 'self' data:` with no asset protocol enabled, so a `file://` src
// paints a broken-image glyph. It would do so on the images that SUCCEEDED — where this panel
// deliberately shows no failure reason — making a good download indistinguishable from a dead one
// and explaining neither. So the bytes come back through Rust (`loadTicketImage`), and a read that
// fails gets the same caution tile and reason a failed DOWNLOAD gets.
//
// ── NO EMOJI ICONS (founder's standing rule) ────────────────────────────────────────────────────
// Every glyph is `react-icons/fi` (Feather). Status is carried by an icon AND a word, never by
// colour alone — a colour-only signal is unreadable to a colour-blind reader and invisible in a
// screenshot pasted into a PR.
//
// ── IT RENDERS FROM THE STORE, NEVER FROM `invoke` ──────────────────────────────────────────────
// Every backend call goes through `services/ticketIntake`, so this component is renderable in jsdom
// by seeding `ticketIntakeStore` — the split `services/verifyGate` and `services/preview` use, for
// the reason stated there: a component that invokes directly cannot be tested at all without a
// bridge mock, so the tests that would catch a regression stop being written.
//
// ── THE FAN-OUT BUTTON RECORDS AN INTENT ────────────────────────────────────────────────────────
// Dispatching a worker per ticket lives in the spawn surface — files this slice does not own. So
// "Send to an agent" writes the key into `ticketIntakeStore.dispatchRequests` and whoever mounts
// this panel reads it. That keeps the button honest (it does something observable, and a test can
// assert it) without editing a sibling's file or pretending the wiring exists. See
// `PRD/ticket-system-intake.md`.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  FiAlertTriangle,
  FiDownloadCloud,
  FiGitBranch,
  FiHelpCircle,
  FiImage,
  FiSend,
  FiTag,
} from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_UI, RADIUS, SPACE, TYPE, WEIGHT } from "../theme/scale";
import { SECTION_LABEL } from "./labelTreatment";
import {
  entryFor,
  humanBytes,
  imageSummary,
  isRenderableImage,
  providerLabel,
  providerSentence,
  fetchReadiness,
  useTicketIntakeStore,
  type IntakedImage,
  type IntakedTicket,
  type TicketRef,
} from "../stores/ticketIntakeStore";
import {
  fetchTicketIntakeStatus,
  fetchTickets,
  loadTicketImage,
  parseTicketRefs,
} from "../services/ticketIntake";

/** Hooks a real-layout or integration test can find the panel by. */
export const TICKET_INTAKE_PANEL_TESTID = "ticket-intake-panel";
export const TICKET_INTAKE_CARD_TESTID = "ticket-intake-card";
export const TICKET_INTAKE_IMAGE_TESTID = "ticket-intake-image";
export const TICKET_INTAKE_FAILURE_TESTID = "ticket-intake-failure";

export interface TicketIntakePanelProps {
  /** The repo whose `[ticket_intake]` settings and attachment directory are used. */
  projectRoot: string;
}

/** The derived strings, as three labelled rows. These are the whole point of the parse half —
 *  they are what a person is otherwise re-typing into `git switch -c` by hand. */
function DerivedRows({ branch, commitPrefix, prTitle }: {
  branch: string;
  commitPrefix: string;
  prTitle: string;
}) {
  return (
    <dl style={derivedList}>
      <div style={derivedRow}>
        <dt style={derivedTerm}>
          <FiGitBranch aria-hidden size={12} style={{ color: C.muted }} /> branch
        </dt>
        <dd style={derivedValue} data-testid="ticket-intake-branch">
          {branch}
        </dd>
      </div>
      <div style={derivedRow}>
        <dt style={derivedTerm}>
          <FiTag aria-hidden size={12} style={{ color: C.muted }} /> commit
        </dt>
        <dd style={derivedValue} data-testid="ticket-intake-commit-prefix">
          {commitPrefix}
        </dd>
      </div>
      <div style={derivedRow}>
        <dt style={derivedTerm}>
          <FiSend aria-hidden size={12} style={{ color: C.muted }} /> PR title
        </dt>
        <dd style={derivedValue} data-testid="ticket-intake-pr-title">
          {prTitle}
        </dd>
      </div>
    </dl>
  );
}

/** The caution tile: a screenshot that is not on screen, and WHY. Shared by a download that failed
 *  and a read-back that failed, because to the reader they are the same fact. */
function DeadTile({ reason }: { reason: string }) {
  return (
    <span style={{ ...deadTile, color: C.amberInk }}>
      <FiAlertTriangle aria-hidden size={13} />
      {/* The REASON, not just a broken tile: an expired Linear link, a 404 and an unreadable file
          are different problems and only some of them are fixed by re-pasting. */}
      <span style={{ fontSize: TYPE.micro }}>{reason}</span>
    </span>
  );
}

/** One downloaded screenshot, read back through Rust as a `data:` URL — see the panel header. */
function Thumb({ projectRoot, image }: { projectRoot: string; image: IntakedImage }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = image.localPath;
  // Guards a state write after the strip has been replaced by a newer fetch — the read is async
  // and the component may be gone by the time it lands.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!path) return;
    setDataUrl(null);
    setError(null);
    void loadTicketImage(projectRoot, path)
      .then((url) => {
        if (live.current) setDataUrl(url);
      })
      .catch((e: unknown) => {
        if (live.current) setError(e instanceof Error ? e.message : String(e));
      });
  }, [projectRoot, path]);

  if (error) return <DeadTile reason={error} />;
  if (!dataUrl) {
    return (
      <span style={{ ...deadTile, color: C.muted, borderStyle: "solid" }}>
        <span style={{ fontSize: TYPE.micro }}>reading…</span>
      </span>
    );
  }
  return <img src={dataUrl} alt={`screenshot from ${image.sourceUrl}`} style={thumb} />;
}

/** One ticket's screenshots. A failed download gets a tile too — see the header. */
function ImageStrip({ projectRoot, images }: { projectRoot: string; images: IntakedImage[] }) {
  if (images.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.xs }}>
      <p style={quietHint} data-testid="ticket-intake-image-summary">
        <FiImage aria-hidden size={12} /> {imageSummary(images)}
      </p>
      <ul style={imageList}>
        {images.map((img) => (
          <li
            key={img.sourceUrl}
            style={imageTile}
            data-testid={TICKET_INTAKE_IMAGE_TESTID}
            data-ok={img.ok ? "true" : "false"}
          >
            {isRenderableImage(img) ? (
              <Thumb projectRoot={projectRoot} image={img} />
            ) : (
              // A row that arrived but is NOT an image gets a tile naming its type, never an
              // <img>: a broken glyph on an `ok` row with a byte count and no reason is the
              // failure this strip is written against. Rust already refuses to download a
              // non-image; this is the second lock on the same door.
              <DeadTile
                reason={
                  img.ok ? `not an image (${img.mime || "unknown type"})` : (img.error ?? "could not fetch")
                }
              />
            )}
            <span style={{ color: C.muted, fontSize: TYPE.micro }}>
              {img.ok ? humanBytes(img.bytes) : "not fetched"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One parsed reference, plus its fetched ticket when there is one. */
function TicketCard({
  projectRoot,
  refItem,
  ticket,
  readiness,
  onDispatch,
  dispatched,
}: {
  projectRoot: string;
  refItem: TicketRef;
  ticket: IntakedTicket | undefined;
  readiness: { ready: boolean; reason: string };
  onDispatch: (key: string) => void;
  dispatched: boolean;
}) {
  const ambiguous = refItem.ambiguous;
  const ink = ambiguous ? C.amberInk : C.cream;
  return (
    <li
      style={card}
      data-testid={TICKET_INTAKE_CARD_TESTID}
      data-key={refItem.key}
      data-ambiguous={ambiguous ? "true" : "false"}
    >
      <div style={cardHead}>
        {ambiguous ? (
          <FiHelpCircle aria-hidden size={14} style={{ color: C.amberInk, flex: "0 0 auto" }} />
        ) : (
          <FiTag aria-hidden size={14} style={{ color: C.muted, flex: "0 0 auto" }} />
        )}
        <span style={{ ...keyText, color: ink }}>{refItem.key}</span>
        <span style={providerText} data-testid="ticket-intake-provider">
          {providerSentence(refItem)}
        </span>
        <button
          type="button"
          style={smallBtn}
          disabled={!ticket || dispatched}
          onClick={() => onDispatch(refItem.key)}
          aria-label={`Send ${refItem.key} to an agent`}
        >
          {dispatched ? "Queued" : "Send to an agent"}
        </button>
      </div>

      {/* The note is where the backend explains itself — why this is ambiguous, or that the answer
          came from `default_provider`. Both are things a user would otherwise have to guess at. */}
      {refItem.note && (
        <p style={{ ...quietHint, color: ambiguous ? C.amberInk : C.muted }}>{refItem.note}</p>
      )}

      {ticket && (
        <p style={titleLine} data-testid="ticket-intake-title">
          {ticket.title}
        </p>
      )}

      <DerivedRows
        branch={ticket?.branch ?? refItem.branch}
        commitPrefix={ticket?.commitPrefix ?? refItem.commitPrefix}
        prTitle={ticket?.prTitle ?? refItem.prTitle}
      />

      {!ticket && !readiness.ready && (
        <p style={quietHint} data-testid="ticket-intake-readiness">
          {readiness.reason}
        </p>
      )}

      {ticket && <ImageStrip projectRoot={projectRoot} images={ticket.images} />}
    </li>
  );
}

export function TicketIntakePanel({ projectRoot }: TicketIntakePanelProps) {
  const entry = useTicketIntakeStore((s) => entryFor(s, projectRoot));
  const requestDispatch = useTicketIntakeStore((s) => s.requestDispatch);
  const patch = useTicketIntakeStore((s) => s.patch);
  const [text, setText] = useState(entry.text);

  // One status read on mount, so the panel can say WHY a fetch is unavailable before anyone
  // presses a disabled button. Deliberately not a poll: config changes are rare and a poll on
  // every mounted project would re-read the config file for the whole fleet.
  useEffect(() => {
    void fetchTicketIntakeStatus(projectRoot);
  }, [projectRoot]);

  const onParse = useCallback(() => {
    patch(projectRoot, { text });
    void parseTicketRefs(projectRoot, text);
  }, [patch, projectRoot, text]);

  const onFetch = useCallback(() => {
    patch(projectRoot, { text });
    void fetchTickets(projectRoot, text).catch(() => {
      // The failure is already in the store's `error`; swallowing here keeps an unhandled
      // rejection out of the console without hiding anything from the user.
    });
  }, [patch, projectRoot, text]);

  const byKey = new Map(entry.tickets.map((t) => [t.key, t]));
  const status = entry.status;

  return (
    <section
      data-testid={TICKET_INTAKE_PANEL_TESTID}
      style={panel}
      aria-label="Ticket intake"
    >
      <div style={header}>
        <span style={SECTION_LABEL}>Paste tickets</span>
        <div style={{ display: "flex", gap: SPACE.sm, alignItems: "center" }}>
          <button type="button" style={smallBtn} onClick={onParse} aria-label="Read references">
            Read references
          </button>
          <button
            type="button"
            style={primaryBtn}
            onClick={onFetch}
            disabled={entry.fetching || entry.refs.length === 0}
            aria-label="Fetch tickets"
          >
            <FiDownloadCloud aria-hidden size={13} />
            {entry.fetching ? "Fetching…" : "Fetch tickets"}
          </button>
        </div>
      </div>

      <textarea
        style={pasteBox}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste ticket keys, links or beads ids — ENG-1234, a linear.app link, a Jira browse URL, #123, .6"
        aria-label="Ticket references"
        data-testid="ticket-intake-paste"
        rows={3}
      />

      {/* THE OFF STATE IS EXPLAINED, NOT HIDDEN. The parser works with intake switched off, so the
          panel stays useful — it just says that fetching needs a line of config. */}
      {status && !status.enabled && (
        <p style={{ ...quietHint, color: C.amberInk }} data-testid="ticket-intake-disabled">
          <FiAlertTriangle aria-hidden size={13} /> Ticket intake is off, so references are parsed
          but nothing is fetched. Set <code style={inlineCode}>[ticket_intake].enabled = true</code>{" "}
          in the global <code style={inlineCode}>config.toml</code>.
        </p>
      )}

      {entry.error && (
        // A COMMAND failure, not a per-ticket one. Said differently on purpose: "we could not reach
        // the backend" is not "Jira refused this ticket".
        <p style={{ ...quietHint, color: C.dangerInk }} role="alert">
          <FiAlertTriangle aria-hidden size={13} /> Couldn&apos;t reach ticket intake: {entry.error}
        </p>
      )}

      {entry.refs.length === 0 && (
        <p style={quietHint} data-testid="ticket-intake-empty">
          No ticket references in that text yet. A key (ENG-1234), a tracker link, a GitHub #123 or
          a beads id all work.
        </p>
      )}

      <ul style={cardList}>
        {entry.refs.map((r) => (
          <TicketCard
            key={`${r.provider ?? "ambiguous"}:${r.key}`}
            projectRoot={projectRoot}
            refItem={r}
            ticket={byKey.get(r.key)}
            readiness={fetchReadiness(status, r.provider)}
            onDispatch={(k) => requestDispatch(projectRoot, k)}
            dispatched={entry.dispatchRequests.includes(r.key)}
          />
        ))}
      </ul>

      {/* PER-REFERENCE failures, listed rather than folded into one sentence. Four tickets that
          arrived and one that did not is a different situation from "the fetch failed", and only
          this list can tell them apart. */}
      {entry.failures.length > 0 && (
        <ul style={failureList}>
          {entry.failures.map((f) => (
            <li
              key={`${f.provider ?? "?"}:${f.key}`}
              style={{ ...quietHint, color: C.amberInk }}
              data-testid={TICKET_INTAKE_FAILURE_TESTID}
            >
              <FiAlertTriangle aria-hidden size={12} />
              <span style={{ fontWeight: WEIGHT.med }}>{f.key}</span>
              <span>
                {providerLabel(f.provider)}: {f.error}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const panel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE.xs,
  fontFamily: FONT_UI,
  fontSize: TYPE.body,
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: SPACE.sm,
};

const pasteBox: CSSProperties = {
  background: C.inputSurface,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: RADIUS.input,
  color: C.cream,
  fontFamily: FONT_UI,
  fontSize: TYPE.small,
  padding: SPACE.sm,
  resize: "vertical",
};

const cardList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE.xs,
  listStyle: "none",
  margin: 0,
  padding: 0,
};

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE.xs,
  paddingTop: SPACE.xs,
  paddingBottom: SPACE.xs,
  borderTop: `1px solid ${C.hairline}`,
  minWidth: 0,
};

const cardHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  minWidth: 0,
};

const keyText: CSSProperties = {
  fontWeight: WEIGHT.bold,
  flex: "0 0 auto",
};

const providerText: CSSProperties = {
  color: C.muted,
  fontSize: TYPE.small,
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const titleLine: CSSProperties = {
  margin: 0,
  fontSize: TYPE.body,
  fontWeight: WEIGHT.med,
  color: C.cream,
};

const derivedList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  margin: 0,
};

const derivedRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  minWidth: 0,
};

const derivedTerm: CSSProperties = {
  alignItems: "center",
  color: C.muted,
  display: "flex",
  flex: "0 0 auto",
  fontSize: TYPE.micro,
  gap: SPACE.xs,
  width: 72,
};

const derivedValue: CSSProperties = {
  color: C.cream,
  fontSize: TYPE.small,
  margin: 0,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const imageList: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: SPACE.xs,
  listStyle: "none",
  margin: 0,
  padding: 0,
};

const imageTile: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  width: 88,
};

const thumb: CSSProperties = {
  border: `1px solid ${C.inputEdge}`,
  borderRadius: RADIUS.input,
  height: 56,
  objectFit: "cover",
  width: 88,
};

const deadTile: CSSProperties = {
  alignItems: "center",
  border: `1px dashed ${C.inputEdge}`,
  borderRadius: RADIUS.input,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  height: 56,
  justifyContent: "center",
  padding: 2,
  textAlign: "center",
  width: 88,
};

const failureList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE.xs,
  listStyle: "none",
  margin: 0,
  padding: 0,
};

const quietHint: CSSProperties = {
  color: C.muted,
  fontSize: TYPE.small,
  margin: 0,
  display: "flex",
  alignItems: "center",
  gap: SPACE.xs,
  flexWrap: "wrap",
};

const inlineCode: CSSProperties = {
  color: C.cream,
  fontSize: TYPE.small,
};

const primaryBtn: CSSProperties = {
  alignItems: "center",
  background: C.teal,
  border: "none",
  borderRadius: RADIUS.input,
  color: C.onFillInk,
  cursor: "pointer",
  display: "flex",
  fontFamily: FONT_UI,
  fontSize: TYPE.small,
  fontWeight: WEIGHT.med,
  gap: SPACE.xs,
  padding: `${SPACE.xs}px ${SPACE.row}px`,
};

const smallBtn: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.inputEdge}`,
  borderRadius: RADIUS.input,
  color: C.cream,
  cursor: "pointer",
  fontFamily: FONT_UI,
  fontSize: TYPE.small,
  padding: `${SPACE.xs}px ${SPACE.row}px`,
};
