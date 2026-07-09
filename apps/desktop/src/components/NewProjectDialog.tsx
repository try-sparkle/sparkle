// The "New Project" dialog opened from the TopBar "New" button. Two tabs:
//   [ From folder ] (default) — runs today's exact native-picker flow (lifted in as onOpenFromFolder
//     so behavior is byte-identical to the old New button).
//   [ From GitHub ]           — sign in / browse repos / clone → open, driven by useGithubImport.
// On a successful clone this calls onCloned(name, path); TopBar wires that into the same
// resolveAndRoute path the Open flow uses, so the cloned project is created AND selected.
//
// Icons: react-icons/Feather only — no emoji-as-icons (house rule).

import { useState, type CSSProperties } from "react";
import { FiGithub, FiLock, FiGlobe, FiSearch, FiLoader, FiChevronLeft } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { ModalShell } from "./ModalShell";
import { signInHandoff } from "../services/trialUnlock";
import { pickProjectFolder } from "../services/dialog";
import { useGithubImport, repoName, type GithubRepo } from "../hooks/useGithubImport";

const XCODE_CLT_CMD = "xcode-select --install";

// Scoped spin keyframes (following SetupChecklist's pattern — there is no global `spin`).
const SPIN_KEYFRAMES = `@keyframes npd-spin { to { transform: rotate(360deg) } }`;

/** A small spinning Feather loader (no emoji-as-icons, per house rule). */
function Spinner() {
  return <FiLoader aria-hidden style={{ animation: "npd-spin 1s linear infinite" }} />;
}

const tabBtn = (active: boolean): CSSProperties => ({
  flex: 1,
  background: active ? C.forest : "transparent",
  color: active ? C.cream : C.muted,
  border: "none",
  borderBottom: `2px solid ${active ? C.teal : "transparent"}`,
  padding: "10px 12px",
  cursor: "pointer",
  fontSize: 14,
  fontWeight: active ? FONT_WEIGHT.semibold : FONT_WEIGHT.regular,
  fontFamily: '"IBM Plex Sans", sans-serif',
});

const primaryBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 8,
  padding: "11px 16px",
  cursor: "pointer",
  fontSize: 14,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: '"IBM Plex Sans", sans-serif',
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
};

const secondaryBtn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "9px 14px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: C.barSurface,
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "9px 12px",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

export function NewProjectDialog({
  onClose,
  onOpenFromFolder,
  onCloned,
  onSignInGithub,
}: {
  onClose: () => void;
  /** Runs today's exact folder flow (startOpen). Lifted in so it stays byte-identical. */
  onOpenFromFolder: () => void;
  /** Create + open + select the freshly cloned project (same route as resolveAndRoute). */
  onCloned: (name: string, path: string) => void;
  /** Override the GitHub sign-in/connect handoff (tests inject a spy). */
  onSignInGithub?: () => void;
}) {
  const [tab, setTab] = useState<"folder" | "github">("folder");

  return (
    <ModalShell width={560} onCancel={onClose}>
      <style>{SPIN_KEYFRAMES}</style>
      <div style={{ fontSize: 18, fontWeight: FONT_WEIGHT.semibold, marginBottom: 14 }}>
        New Project
      </div>

      <div
        style={{
          display: "flex",
          borderBottom: `1px solid ${C.forest}`,
          marginBottom: 18,
        }}
      >
        <button role="tab" aria-selected={tab === "folder"} style={tabBtn(tab === "folder")} onClick={() => setTab("folder")}>
          From folder
        </button>
        <button role="tab" aria-selected={tab === "github"} style={tabBtn(tab === "github")} onClick={() => setTab("github")}>
          From GitHub
        </button>
      </div>

      {tab === "folder" ? (
        <FolderTab
          onChoose={() => {
            onClose();
            onOpenFromFolder();
          }}
        />
      ) : (
        <GithubTab onClose={onClose} onCloned={onCloned} onSignInGithub={onSignInGithub} />
      )}
    </ModalShell>
  );
}

function FolderTab({ onChoose }: { onChoose: () => void }) {
  return (
    <div>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 18, lineHeight: 1.5 }}>
        Choose or create a folder on your Mac for this project. The picker&apos;s &ldquo;New
        Folder&rdquo; button makes a fresh one.
      </div>
      <button style={primaryBtn} onClick={onChoose}>
        Choose a folder…
      </button>
    </div>
  );
}

function GithubTab({
  onClose,
  onCloned,
  onSignInGithub,
}: {
  onClose: () => void;
  onCloned: (name: string, path: string) => void;
  onSignInGithub?: () => void;
}) {
  const gh = useGithubImport(true);
  const [signInFailedUrl, setSignInFailedUrl] = useState<string | null>(null);

  const signIn = onSignInGithub ?? (() => void signInHandoff(setSignInFailedUrl));

  const handleClone = async () => {
    const path = await gh.clone();
    if (path) {
      onCloned(repoName(path), path);
      onClose();
    }
  };

  const changeDest = async () => {
    if (!gh.selected) return;
    const parent = await pickProjectFolder("Choose a folder to clone into");
    if (parent) gh.setDest(`${parent.replace(/[/\\]+$/, "")}/${repoName(gh.selected.fullName)}`);
  };

  if (gh.phase === "loading") {
    return (
      <div style={{ color: C.muted, fontSize: 13, display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }}>
        <Spinner />
        Checking GitHub…
      </div>
    );
  }

  if (gh.phase === "signed-out") {
    return (
      <div>
        <div style={{ color: C.muted, fontSize: 13, marginBottom: 18, lineHeight: 1.5 }}>
          Sign in with GitHub to browse your repositories — including private ones — and clone one
          into a new project. We&apos;ll open your browser to connect.
        </div>
        <button style={primaryBtn} onClick={() => signIn()}>
          <FiGithub aria-hidden />
          Sign in with GitHub
        </button>
        {signInFailedUrl && (
          <p style={{ color: C.muted, fontSize: 12, marginTop: 12, wordBreak: "break-all" }} role="alert">
            Couldn&apos;t open your browser. Open this link manually:{" "}
            <span style={{ color: C.cream, userSelect: "text" }}>{signInFailedUrl}</span>
          </p>
        )}
      </div>
    );
  }

  // connected
  if (gh.selected) {
    return (
      <DestinationView
        repo={gh.selected}
        dest={gh.dest}
        setDest={gh.setDest}
        onChangeDest={() => void changeDest()}
        cloning={gh.cloning}
        cloneError={gh.cloneError}
        onBack={gh.clearSelected}
        onClone={() => void handleClone()}
      />
    );
  }

  return <RepoBrowser gh={gh} />;
}

function RepoBrowser({ gh }: { gh: ReturnType<typeof useGithubImport> }) {
  return (
    <div>
      <div style={{ position: "relative", marginBottom: 12 }}>
        <FiSearch
          aria-hidden
          style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: C.muted }}
        />
        <input
          aria-label="Search repositories"
          placeholder="Search your repositories…"
          value={gh.query}
          onChange={(e) => gh.setQuery(e.target.value)}
          style={{ ...inputStyle, paddingLeft: 32 }}
        />
      </div>

      {gh.reposError && (
        <div style={{ color: C.muted, fontSize: 13, padding: "8px 0" }} role="alert">
          {gh.reposError}
        </div>
      )}

      <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {gh.repos.map((r) => (
          <RepoRow key={r.fullName} repo={r} onSelect={() => gh.select(r)} />
        ))}

        {!gh.loadingRepos && gh.repos.length === 0 && !gh.reposError && (
          <div style={{ color: C.muted, fontSize: 13, padding: "12px 2px" }}>No repositories found.</div>
        )}

        {gh.loadingRepos && (
          <div style={{ color: C.muted, fontSize: 13, display: "flex", alignItems: "center", gap: 8, padding: "8px 2px" }}>
            <Spinner />
            Loading…
          </div>
        )}
      </div>

      {gh.hasMore && !gh.loadingRepos && (
        <button style={{ ...secondaryBtn, marginTop: 12, width: "100%" }} onClick={gh.loadMore}>
          Load more
        </button>
      )}
    </div>
  );
}

function RepoRow({ repo, onSelect }: { repo: GithubRepo; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        background: C.barSurface,
        border: `1px solid ${C.forest}`,
        borderRadius: 8,
        padding: "10px 12px",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: '"IBM Plex Sans", sans-serif',
      }}
    >
      <span style={{ marginTop: 2, color: C.muted, flex: "0 0 auto" }} title={repo.private ? "Private" : "Public"}>
        {repo.private ? <FiLock aria-label="Private" /> : <FiGlobe aria-label="Public" />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", color: C.cream, fontSize: 13, fontWeight: FONT_WEIGHT.medium }}>
          {repo.fullName}
        </span>
        {repo.description && (
          <span
            style={{
              display: "block",
              color: C.muted,
              fontSize: 12,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {repo.description}
          </span>
        )}
      </span>
    </button>
  );
}

function DestinationView({
  repo,
  dest,
  setDest,
  onChangeDest,
  cloning,
  cloneError,
  onBack,
  onClone,
}: {
  repo: GithubRepo;
  dest: string;
  setDest: (d: string) => void;
  onChangeDest: () => void;
  cloning: boolean;
  cloneError: ReturnType<typeof useGithubImport>["cloneError"];
  onBack: () => void;
  onClone: () => void;
}) {
  if (cloning) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 0", color: C.cream, fontSize: 14 }}>
        <Spinner />
        Cloning <strong style={{ fontWeight: FONT_WEIGHT.semibold }}>{repo.fullName}</strong>…
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        style={{ ...secondaryBtn, border: "none", padding: "2px 0", marginBottom: 12, color: C.muted, display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        <FiChevronLeft aria-hidden /> Back to repositories
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ color: C.muted }}>{repo.private ? <FiLock aria-label="Private" /> : <FiGlobe aria-label="Public" />}</span>
        <span style={{ color: C.cream, fontSize: 15, fontWeight: FONT_WEIGHT.semibold }}>{repo.fullName}</span>
      </div>

      <label style={{ display: "block", color: C.muted, fontSize: 12, marginBottom: 6 }} htmlFor="clone-dest">
        Clone into
      </label>
      <div style={{ display: "flex", gap: 8, marginBottom: cloneError ? 12 : 18 }}>
        <input id="clone-dest" aria-label="Clone destination" value={dest} onChange={(e) => setDest(e.target.value)} style={inputStyle} />
        <button style={{ ...secondaryBtn, flex: "0 0 auto" }} onClick={onChangeDest}>
          Change…
        </button>
      </div>

      {cloneError?.kind === "git_missing" && (
        <div
          role="alert"
          style={{ background: C.barSurface, border: `1px solid ${C.muted}`, borderRadius: 8, padding: "12px 14px", marginBottom: 18 }}
        >
          <div style={{ color: C.cream, fontSize: 13, fontWeight: FONT_WEIGHT.medium, marginBottom: 6 }}>
            Git isn&apos;t installed yet
          </div>
          <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}>
            Install Apple&apos;s Xcode Command Line Tools, then try again. Run this in Terminal:
          </div>
          <code
            style={{ display: "block", background: C.forest, color: C.cream, borderRadius: 6, padding: "8px 10px", fontSize: 12, userSelect: "text" }}
          >
            {XCODE_CLT_CMD}
          </code>
        </div>
      )}
      {cloneError?.kind === "other" && (
        <div role="alert" style={{ color: C.muted, fontSize: 12, marginBottom: 18, wordBreak: "break-word" }}>
          {cloneError.message}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button style={primaryBtn} onClick={onClone} disabled={!dest.trim()}>
          Clone &amp; Open
        </button>
      </div>
    </div>
  );
}
