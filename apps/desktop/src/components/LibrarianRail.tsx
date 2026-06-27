// LibrarianRail — the live grounding side-rail for the Think interview. Shows what Chief's
// background "librarian" and "skeptic" surface as you talk: two lanes (Grounding / Challenges)
// populated out-of-band by `services/librarian.ts`. Each item is clickable to pull it into the
// conversation. This is a read surface — it never drives Chief itself (the librarian service does).
import { C, FONT_WEIGHT } from "../theme/colors";
import { useLibrarianStore } from "../stores/librarianStore";
import type { LibrarianItem } from "../stores/librarianStore";

export function LibrarianRail({
  agentId,
  onInject,
}: {
  agentId: string;
  onInject: (text: string) => void;
}) {
  const lanes = useLibrarianStore((s) => s.byAgent[agentId]);
  const grounding = lanes?.grounding ?? [];
  const challenges = lanes?.challenges ?? [];
  const status = lanes?.status ?? "idle";

  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        borderLeft: `1px solid ${C.deepForest}`,
        background: C.forest,
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: `1px solid ${C.deepForest}`,
          color: C.muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span>Chief is listening</span>
        {status === "thinking" && (
          <span style={{ color: C.teal, fontStyle: "italic", textTransform: "none" }}>
            researching…
          </span>
        )}
      </div>

      <Lane title="📚 Grounding" empty="As you talk, relevant prior decisions appear here." items={grounding} onInject={onInject} />
      <Lane title="⚖️ Challenges" empty="The skeptic will push back here." items={challenges} onInject={onInject} accent />
    </div>
  );
}

function Lane({
  title,
  empty,
  items,
  onInject,
  accent,
}: {
  title: string;
  empty: string;
  items: LibrarianItem[];
  onInject: (text: string) => void;
  accent?: boolean;
}) {
  return (
    <div style={{ padding: "8px 10px" }}>
      <div
        style={{
          color: accent ? C.sienna : C.cream,
          fontSize: 12,
          fontWeight: FONT_WEIGHT.semibold,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {items.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 11, lineHeight: 1.5, opacity: 0.8 }}>{empty}</div>
      ) : (
        items.map((it, i) => (
          <button
            // Content-based key: the librarian replaces lane contents wholesale each turn, so an
            // index key would let React mis-reconcile across replacements. ts disambiguates dup text.
            key={`${it.ts}-${it.text}`}
            onClick={() => onInject(it.text)}
            title="Pull this into the conversation"
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: C.deepForest,
              color: C.cream,
              border: `1px solid ${accent ? C.sienna : C.forest}`,
              borderRadius: 8,
              padding: "6px 8px",
              marginBottom: 6,
              fontSize: 11.5,
              lineHeight: 1.45,
              cursor: "pointer",
            }}
          >
            {it.text}
            {it.docRefs.length > 0 && (
              <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4 }}>
                {it.docRefs.map((ref, j) => (
                  <span
                    key={`${j}-${ref}`}
                    style={{
                      fontSize: 10,
                      fontFamily: "monospace",
                      color: C.muted,
                      background: C.forest,
                      borderRadius: 4,
                      padding: "1px 4px",
                    }}
                  >
                    {ref}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))
      )}
    </div>
  );
}
