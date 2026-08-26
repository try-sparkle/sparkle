// ticketIntake — the ONE module that talks to the Rust ticket-intake backend (bead `.6`).
//
// Every `invoke` lives here, so `TicketIntakePanel` is testable by seeding `ticketIntakeStore`
// instead of stubbing the Tauri bridge. Same split as `services/verifyGate` and `services/preview`,
// for the same reason: a component that invokes directly cannot be rendered in jsdom at all without
// a bridge mock, so the tests that would catch a regression stop being written.
//
// THE COMMAND NAMES AND PAYLOAD SHAPES ARE A FROZEN CONTRACT with `ticket_intake.rs`. Do not rename
// a field to something that reads better — see the `T | null` rule at the top of
// `ticketIntakeStore`.
import { invoke } from "@tauri-apps/api/core";
import {
  useTicketIntakeStore,
  type BatchResult,
  type TicketIntakeStatus,
  type TicketRef,
} from "../stores/ticketIntakeStore";

/**
 * In-flight fetches, keyed by project root.
 *
 * COALESCED, because a fetch downloads every screenshot in every pasted ticket — seconds of
 * network, and files written to one directory. Two overlapping fetches for one project would
 * duplicate that work and race on the same content-addressed paths. The late caller gets the
 * WINNER'S real outcome rather than a silent skip: a skip would leave its caller with nothing to
 * render. Same shape as `verifyGate.runVerifyGate`.
 */
const inFlight = new Map<string, Promise<BatchResult>>();

/**
 * Parse pasted text into references.
 *
 * NEEDS NO CREDENTIAL AND NO `enabled`, deliberately — reading `ENG-1234` out of a paste and
 * deriving a branch name from it is useful on its own, and it is what makes the panel show
 * something the first time a user opens it rather than a configuration lecture.
 *
 * Resolves with an EMPTY LIST for text that holds no reference. That is a real answer (a user
 * pastes a paragraph of context), not a failure, and the store records it as such.
 */
export async function parseTicketRefs(
  projectRoot: string,
  text: string,
): Promise<TicketRef[]> {
  try {
    const refs = await invoke<TicketRef[]>("ticket_intake_parse", { projectRoot, text });
    const list = refs ?? [];
    useTicketIntakeStore.getState().applyRefs(projectRoot, list);
    return list;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useTicketIntakeStore.getState().patch(projectRoot, { error: message });
    return [];
  }
}

/**
 * Fetch every reference in `text` and fold the per-ref outcomes into the store.
 *
 * Rejects when the COMMAND failed (the fetch could not happen at all); a fetch that happened and
 * could not read three of five tickets RESOLVES, with those three in `failures`. Those are
 * different facts and the panel renders them differently — "we could not reach the backend" is not
 * "Jira refused this ticket".
 */
export async function fetchTickets(
  projectRoot: string,
  text: string,
): Promise<BatchResult> {
  const existing = inFlight.get(projectRoot);
  if (existing) return existing;

  const store = useTicketIntakeStore.getState();
  // Optimistic, so the button disables on CLICK rather than on the next render — a fetch with
  // screenshots takes seconds, and a button that stays live gets pressed twice.
  store.patch(projectRoot, { fetching: true, error: null });

  const run = (async () => {
    try {
      const batch = await invoke<BatchResult>("ticket_intake_fetch", { projectRoot, text });
      const safe: BatchResult = {
        tickets: batch?.tickets ?? [],
        failures: batch?.failures ?? [],
      };
      useTicketIntakeStore.getState().applyBatch(projectRoot, safe);
      return safe;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      useTicketIntakeStore.getState().patch(projectRoot, { error: message });
      throw e;
    } finally {
      // ALWAYS clear both, on every path. A stuck `fetching` is a permanently disabled button, and
      // a stuck `inFlight` entry means this project can never fetch again in this session.
      inFlight.delete(projectRoot);
      useTicketIntakeStore.getState().patch(projectRoot, { fetching: false });
    }
  })();

  inFlight.set(projectRoot, run);
  return run;
}

/**
 * Is intake on, and which providers can be used.
 *
 * A status we could NOT read leaves `status` alone rather than writing an "off" shape. `patch`
 * leaves untouched fields as they were, which is what keeps a transient bridge failure from
 * rendering as "your ticket intake is disabled" — a sentence that would send someone to edit a
 * config file that is already correct.
 */
export async function fetchTicketIntakeStatus(
  projectRoot: string,
): Promise<TicketIntakeStatus | null> {
  try {
    const status = await invoke<TicketIntakeStatus>("ticket_intake_status", { projectRoot });
    if (!status) return null;
    useTicketIntakeStore.getState().applyStatus(projectRoot, status);
    return status;
  } catch (e) {
    useTicketIntakeStore
      .getState()
      .patch(projectRoot, { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * One downloaded screenshot, as a `data:` URL.
 *
 * NOT `file://`, and this is not a style choice. The webview's CSP is `img-src 'self' data:`
 * (`tauri.conf.json`) with no asset protocol enabled, so a `file://` src renders a broken-image
 * glyph — and it does so on the images that SUCCEEDED, where the panel shows no failure reason at
 * all, making a good download indistinguishable from a dead one. Every other on-disk image in this
 * app is read through Rust and shown as a `data:` URL for exactly this reason.
 *
 * CACHED per path, because a data URL is the file's whole contents: re-reading and re-encoding a
 * two-megabyte screenshot on every render of the strip is real main-thread work in Rust and real
 * IPC. The cache is keyed by the content-addressed path, so a changed image is a different key.
 */
const imageCache = new Map<string, Promise<string>>();

/**
 * How many decoded screenshots the cache may hold.
 *
 * BOUNDED, because each entry is a whole file as base64 — a handful of full-page captures is tens
 * of megabytes held in the renderer for as long as the session lasts. Insertion-ordered eviction
 * (a `Map` iterates in insertion order) is enough here: the strip reads its images together, so the
 * oldest entry is reliably the least interesting one.
 */
const IMAGE_CACHE_MAX = 24;

export async function loadTicketImage(
  projectRoot: string,
  localPath: string,
): Promise<string> {
  const key = `${projectRoot}::${localPath}`;
  const existing = imageCache.get(key);
  if (existing) return existing;
  const run = invoke<string>("ticket_intake_image", { projectRoot, path: localPath }).then(
    (url) => {
      if (!url) throw new Error(`no data came back for ${localPath}`);
      return url;
    },
  );
  // A FAILED read is NOT cached: the file may be mid-write, or the directory may not exist yet on
  // the very first fetch. Caching the rejection would make one unlucky read permanent for the
  // session, on a path that is otherwise perfectly readable a second later.
  run.catch(() => imageCache.delete(key));
  imageCache.set(key, run);
  while (imageCache.size > IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next();
    if (oldest.done || oldest.value === key) break;
    imageCache.delete(oldest.value);
  }
  return run;
}
