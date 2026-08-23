/** Sample sources for the `be-transparent-and-honest` detectors. */

// --- fabricated-scarcity-or-social-proof -----------------------------------------------

export const scarcityLiteralFires = `
export function StockBadge() {
  return <p className="urgent">Only 3 left in stock</p>;
}
`;

/** The same sentence, reading a real figure. */
export const scarcityLiteralNearMissRealData = `
export function StockBadge({ stock }) {
  return <p className="urgent">Only {stock.remaining} left in stock</p>;
}
`;

/**
 * Matches the scarcity wording, but the sentence is plainly about retries. Engineering
 * counters are not urgency aimed at a buyer, and firing on them would be the first false
 * positive anyone hit.
 */
export const scarcityLiteralNearMissRetryCounter = `
export function queueNotice() {
  return 'Only 3 items remaining in the retry queue';
}
`;

export const socialProofRandomFires = `
export function ViewerCount() {
  const viewers = Math.floor(Math.random() * 20) + 5;
  return <p>{viewers} people are viewing this right now</p>;
}
`;

/** Math.random, but nowhere near a scarcity or social-proof claim. */
export const socialProofRandomNearMiss = `
export function pickPlaceholderAvatar(avatars) {
  return avatars[Math.floor(Math.random() * avatars.length)];
}
`;

/** A measured viewer count. The claim is the same; the number is real. */
export const socialProofNearMissMeasured = `
export function ViewerCount({ presence }) {
  return <p>{presence.count} people are viewing this right now</p>;
}
`;

// --- progress-not-bound-to-work --------------------------------------------------------

export const fakeProgressFires = `
import { useEffect, useState } from 'react';

export function ImportProgress() {
  const [percent, setPercent] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setPercent((p) => Math.min(100, p + 4));
    }, 120);
    return () => clearInterval(id);
  }, []);
  return <div className="bar" />;
}
`;

/** Polls the real job and reports what it says. */
export const fakeProgressNearMissRealJob = `
import { useEffect, useState } from 'react';

export function ImportProgress({ jobId }) {
  const [percent, setPercent] = useState(0);
  useEffect(() => {
    const id = setInterval(async () => {
      const snapshot = await fetchImportJob(jobId);
      setPercent(snapshot.percentComplete);
    }, 1000);
    return () => clearInterval(id);
  }, [jobId]);
  return <div className="bar" />;
}
`;

/**
 * A timer that still advances by a literal step, but the step is scaled by bytes actually
 * received. Isolates the real-work suppressor: everything else about this fires.
 */
export const fakeProgressNearMissRealBytes = `
import { useEffect, useState } from 'react';

export function DownloadProgress({ total }) {
  const [percent, setPercent] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setPercent((p) => Math.min(100, p + 1 * (bytesReceived() / total)));
    }, 120);
    return () => clearInterval(id);
  }, [total]);
  return <div className="bar" />;
}
`;

/** A timer that has nothing to do with progress. */
export const fakeProgressNearMissClock = `
import { useEffect, useState } from 'react';

export function Clock() {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setNow((n) => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return <div className="clock">{now}</div>;
}
`;
