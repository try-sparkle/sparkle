/**
 * Sample sources for the `respect-user-attention` and `protect-dignity-and-safety`
 * detectors.
 */

// --- infinite-scroll-no-terminus -------------------------------------------------------

export const infiniteScrollFires = `
import { useEffect, useRef, useState } from 'react';

export function Feed({ initial }) {
  const [posts, setPosts] = useState(initial);
  const [page, setPage] = useState(1);
  const sentinel = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setPage(page + 1);
    });
    if (sentinel.current) observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [page]);

  return (
    <div>
      {posts.map((p) => (
        <article key={p.id}>{p.title}</article>
      ))}
      <div ref={sentinel} />
    </div>
  );
}
`;

/** The same feed, but it knows when it has run out and says so. */
export const infiniteScrollNearMissHasMore = `
import { useEffect, useRef, useState } from 'react';

export function Feed({ initial }) {
  const [posts, setPosts] = useState(initial);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const sentinel = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore) setPage(page + 1);
    });
    if (sentinel.current) observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [page, hasMore]);

  return (
    <div>
      {posts.map((p) => (
        <article key={p.id}>{p.title}</article>
      ))}
      {hasMore ? <div ref={sentinel} /> : <p>You have reached the end of the feed.</p>}
    </div>
  );
}
`;

/** Paging the person asked for. Nothing loads until they press the control. */
export const infiniteScrollNearMissManualControl = `
import { useState } from 'react';

export function Feed({ initial }) {
  const [posts, setPosts] = useState(initial);
  const [page, setPage] = useState(1);

  return (
    <div>
      {posts.map((p) => (
        <article key={p.id}>{p.title}</article>
      ))}
      <button type="button" onClick={() => setPage(page + 1)}>Load more</button>
    </div>
  );
}
`;

// --- user-content-in-analytics ---------------------------------------------------------

export const analyticsUserContentFires = `
import { analytics } from './analytics.ts';

export function recordSend(draft, user) {
  analytics.track('message_sent', {
    conversationId: draft.conversationId,
    body: draft.body,
    email: user.email,
  });
}
`;

/** Shape and size of the same message, without the message. */
export const analyticsUserContentNearMissMetrics = `
import { analytics } from './analytics.ts';

export function recordSend(draft, user) {
  analytics.track('message_sent', {
    conversationId: draft.conversationId,
    bodyLength: draft.body.length,
    messageId: draft.id,
    emailDomain: domainOf(user.email),
  });
}
`;

/** A hard-coded label named `message`, and a thrown error's own text. Neither is the person's words. */
export const analyticsUserContentNearMissLiteralAndError = `
import { analytics } from './analytics.ts';

export function recordBannerShown() {
  analytics.track('cta_shown', { message: 'welcome_banner' });
}

export function recordFailure(err) {
  analytics.track('save_failed', { message: err.message });
}
`;

/** Not an analytics call. Sending someone their own draft is the point of the product. */
export const analyticsUserContentNearMissNotAnalytics = `
import { api } from './api.ts';

export function saveDraft(draft) {
  return api.post('/drafts', { body: draft.body, email: draft.recipient });
}
`;
