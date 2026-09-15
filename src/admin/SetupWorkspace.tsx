import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  commandId,
  PROTOCOL_VERSION,
  type AdminShowProjection,
} from "../../shared/domain";
import { CURATED_THEMES, type ThemeId } from "../../shared/themes";
import { PLATFORM_ATTRIBUTION } from "../../shared/platform";
import { applyShowTheme } from "../theme";
import type { RealtimeClient } from "../realtime/RealtimeClient";
import { JudgeLinks } from "./JudgeLinks";
import { PreflightPanel } from "./PreflightPanel";
import { ProjectorPairingPanel } from "./ProjectorPairingPanel";
import { PublicTextPanel } from "./PublicTextPanel";

interface FontEntry {
  family: string;
  category: string;
  variants: readonly string[];
}

interface IssuedJudge {
  judgeId: string;
  slot: number;
  displayName: string;
  link: string;
}

export interface SetupWorkspaceProps {
  projection: AdminShowProjection;
  client: RealtimeClient;
  judgeConnections: ReadonlySet<string>;
  send: Parameters<typeof PublicTextPanel>[0]["send"];
}

async function responseError(response: Response): Promise<string> {
  const result = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return result?.error ?? `Request failed (HTTP ${response.status})`;
}

export function SetupWorkspace({
  projection,
  client,
  judgeConnections,
  send,
}: SetupWorkspaceProps) {
  const saved = projection.show;
  const [title, setTitle] = useState(saved.title);
  const [shortName, setShortName] = useState(saved.shortName);
  const [tagline, setTagline] = useState(saved.tagline);
  const [themeId, setThemeId] = useState<ThemeId>(saved.themeId);
  const [fontFamily, setFontFamily] = useState(saved.fontFamily);
  const [reactionsEnabled, setReactionsEnabled] = useState(
    saved.reactionsEnabled,
  );
  const [judgeCount, setJudgeCount] = useState(
    Math.max(1, projection.judges.length || 4),
  );
  const [audiencePercent, setAudiencePercent] = useState(
    Math.round(saved.audienceWeight * 100),
  );
  const [fontQuery, setFontQuery] = useState("");
  const [fontCategory, setFontCategory] = useState("all");
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  const [fontBusy, setFontBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [scoringLocked, setScoringLocked] = useState(false);
  const [resetPhrase, setResetPhrase] = useState("");
  const [issued, setIssued] = useState<IssuedJudge[]>([]);

  useEffect(() => {
    setTitle(saved.title);
    setShortName(saved.shortName);
    setTagline(saved.tagline);
    setThemeId(saved.themeId);
    setFontFamily(saved.fontFamily);
    setReactionsEnabled(saved.reactionsEnabled);
    setAudiencePercent(Math.round(saved.audienceWeight * 100));
  }, [
    saved.title,
    saved.shortName,
    saved.tagline,
    saved.themeId,
    saved.fontFamily,
    saved.reactionsEnabled,
    saved.audienceWeight,
  ]);

  useEffect(() => {
    if (projection.judges.length > 0) setJudgeCount(projection.judges.length);
  }, [projection.judges.length]);

  // Theme choices preview immediately; leaving this workspace restores the
  // authoritative saved appearance if the operator did not save.
  useEffect(() => {
    applyShowTheme(themeId, fontFamily);
    return () => applyShowTheme(saved.themeId, saved.fontFamily);
  }, [themeId, fontFamily, saved.themeId, saved.fontFamily]);

  const categories = useMemo(
    () => [...new Set(fonts.map((font) => font.category))].sort(),
    [fonts],
  );
  const visibleFonts = fonts.filter(
    (font) => fontCategory === "all" || font.category === fontCategory,
  );

  async function saveIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const response = await fetch("/api/admin/show", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        shortName,
        tagline,
        themeId,
        fontFamily,
        reactionsEnabled,
      }),
    });
    setBusy(false);
    setNotice(
      response.ok ? "Event appearance saved." : await responseError(response),
    );
  }

  async function searchFonts() {
    setFontBusy(true);
    setNotice(null);
    const response = await fetch(
      `/api/admin/fonts?q=${encodeURIComponent(fontQuery)}&limit=40`,
      { credentials: "same-origin" },
    );
    const result = (await response.json().catch(() => null)) as {
      fonts?: FontEntry[];
      error?: string;
    } | null;
    setFontBusy(false);
    if (!response.ok) {
      setNotice(result?.error ?? "Font catalogue unavailable.");
      return;
    }
    setFonts(result?.fonts ?? []);
    setFontCategory("all");
  }

  async function applyScoring(reset: boolean) {
    setBusy(true);
    setNotice(null);
    const response = await fetch("/api/admin/scoring-config", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        judgeCount,
        audienceWeight: audiencePercent / 100,
        reset,
        confirm: reset ? resetPhrase : null,
      }),
    });
    const result = (await response.json().catch(() => null)) as {
      scoringReset?: boolean;
      issuedJudges?: IssuedJudge[];
      error?: string;
    } | null;
    setBusy(false);
    if (!response.ok) {
      setScoringLocked(response.status === 409);
      setNotice(
        result?.error ?? `Scoring update failed (HTTP ${response.status}).`,
      );
      return;
    }
    setScoringLocked(false);
    setResetPhrase("");
    setIssued(result?.issuedJudges ?? []);
    setNotice(
      result?.scoringReset
        ? "Scoring data reset and configuration applied."
        : "Scoring configuration applied.",
    );
  }

  function clearReactions(): void {
    const sent = client.send({
      type: "clear_reactions",
      protocolVersion: PROTOCOL_VERSION,
      commandId: commandId(crypto.randomUUID().replaceAll("-", "")),
    });
    setNotice(
      sent
        ? "Reaction lane cleared on the projector."
        : "Projector clear was not sent because the control link is offline.",
    );
  }

  const judgeShare = (100 - audiencePercent) / judgeCount;

  return (
    <div className="setup-hq">
      <header className="setup-hq__hero">
        <p>SHOW SETUP HQ</p>
        <h2>Make the room ready before doors open.</h2>
        <span>
          Identity, scoring, access, media readiness and live links in one
          deliberate checklist.
        </span>
      </header>

      <section
        className="setup-section setup-identity"
        aria-labelledby="setup-event-title"
      >
        <div className="region-title">
          <p>01 / EVENT</p>
          <h2 id="setup-event-title">Event identity</h2>
          <span>
            Preview changes here, then save to propagate them to every surface.
          </span>
        </div>
        <form
          className="setup-form"
          onSubmit={(event) => void saveIdentity(event)}
        >
          <label>
            Event title
            <input
              required
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Short name
            <input
              maxLength={60}
              value={shortName}
              onChange={(event) => setShortName(event.target.value)}
              placeholder="Shown on phones"
            />
          </label>
          <label className="setup-form__wide">
            Tagline
            <input
              maxLength={160}
              value={tagline}
              onChange={(event) => setTagline(event.target.value)}
            />
          </label>
          <div className="setup-subsection setup-form__wide">
            <p>APPEARANCE</p>
            <h3>Theme and type</h3>
            <span>Curated, broadcast-safe treatments for every surface.</span>
          </div>
          <fieldset className="theme-picker setup-form__wide">
            <legend>Curated theme</legend>
            {CURATED_THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={themeId === theme.id ? "is-active" : ""}
                aria-pressed={themeId === theme.id}
                onClick={() => setThemeId(theme.id)}
              >
                <i
                  style={{
                    background: `linear-gradient(90deg, ${theme.web.background} 0 48%, ${theme.web.accent} 48%)`,
                  }}
                />
                {theme.name}
              </button>
            ))}
          </fieldset>
          <div className="font-picker setup-form__wide">
            <label>
              Typeface
              <select
                value={fontFamily}
                onChange={(event) => setFontFamily(event.target.value)}
              >
                <option value="system-ui">System UI (offline-safe)</option>
                {visibleFonts.map((font) => (
                  <option key={font.family} value={font.family}>
                    {font.family} · {font.category}
                  </option>
                ))}
              </select>
            </label>
            <div className="font-search">
              <input
                aria-label="Search Google Fonts"
                value={fontQuery}
                onChange={(event) => setFontQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void searchFonts();
                  }
                }}
                placeholder="Search Google Fonts"
              />
              <button
                type="button"
                disabled={fontBusy}
                onClick={() => void searchFonts()}
              >
                {fontBusy ? "SEARCHING…" : "SEARCH"}
              </button>
              {categories.length > 0 && (
                <select
                  aria-label="Font category"
                  value={fontCategory}
                  onChange={(event) => setFontCategory(event.target.value)}
                >
                  <option value="all">All categories</option>
                  {categories.map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <div
            className="brand-preview setup-form__wide"
            style={{
              fontFamily: fontFamily === "system-ui" ? "system-ui" : fontFamily,
            }}
          >
            <small>LIVE PREVIEW</small>
            <strong>{title || "Untitled event"}</strong>
            <span>{tagline || "Your event tagline"}</span>
            <em>Audience Score 8.73</em>
          </div>
          <label className="switch-row setup-form__wide">
            <input
              type="checkbox"
              checked={reactionsEnabled}
              onChange={(event) => setReactionsEnabled(event.target.checked)}
            />
            <span>Audience reactions enabled</span>
          </label>
          <div className="setup-actions setup-form__wide">
            <button type="submit" disabled={busy}>
              SAVE EVENT APPEARANCE
            </button>
            <button type="button" onClick={clearReactions}>
              CLEAR PROJECTOR REACTIONS
            </button>
          </div>
        </form>
      </section>

      <section className="setup-section" aria-labelledby="setup-scoring-title">
        <div className="region-title">
          <p>02 / SCORING</p>
          <h2 id="setup-scoring-title">Scoring model</h2>
          <span>
            Judge and audience allocation totals 100%. Changes lock once scoring
            data exists.
          </span>
        </div>
        <div className="scoring-config">
          <label>
            Adjudicators
            <input
              type="number"
              min={1}
              max={8}
              value={judgeCount}
              onChange={(event) =>
                setJudgeCount(
                  Math.min(8, Math.max(1, Number(event.target.value) || 1)),
                )
              }
            />
          </label>
          <label className="weight-control">
            Audience weight{" "}
            <b>
              {audiencePercent}% audience / {100 - audiencePercent}% judges
            </b>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={audiencePercent}
              onChange={(event) =>
                setAudiencePercent(Number(event.target.value))
              }
            />
          </label>
          <p className="scoring-impact">
            <strong>
              {judgeCount} judge{judgeCount === 1 ? "" : "s"}
            </strong>
            <span>
              {100 - audiencePercent}% judge share · approximately{" "}
              {judgeShare.toFixed(2)}% each of the overall score.
            </span>
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyScoring(false)}
          >
            APPLY SCORING CONFIGURATION
          </button>
          {scoringLocked && (
            <div className="scoring-reset">
              <strong>
                Existing scoring data protects this configuration.
              </strong>
              <span>
                Resetting removes every audience vote, judge submission and
                finalised result. Acts and media remain.
              </span>
              <input
                value={resetPhrase}
                onChange={(event) => setResetPhrase(event.target.value)}
                placeholder="Type RESET SCORING"
              />
              <button
                type="button"
                disabled={busy || resetPhrase !== "RESET SCORING"}
                onClick={() => void applyScoring(true)}
              >
                RESET SCORING AND APPLY
              </button>
            </div>
          )}
        </div>
        {issued.length > 0 && (
          <div className="issued-links">
            <strong>New links — copy now; they cannot be shown again.</strong>
            {issued.map((judge) => (
              <p key={judge.judgeId}>
                <b>{judge.displayName}</b>
                <code>{judge.link}</code>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard?.writeText(judge.link)
                  }
                >
                  COPY
                </button>
              </p>
            ))}
          </div>
        )}
      </section>

      {notice && (
        <output className="setup-notice" role="status">
          {notice}
        </output>
      )}
      <ProjectorPairingPanel />
      <JudgeLinks
        key={projection.judges.map((judge) => judge.id).join(":")}
        judgeConnections={judgeConnections}
      />
      <PublicTextPanel
        intermissionMessage={saved.intermissionMessage}
        emergencyMessage={saved.emergencyMessage}
        send={send}
      />
      <details className="setup-readiness" open>
        <summary>03 / SHOW READINESS</summary>
        <PreflightPanel client={client} />
      </details>
      <footer className="setup-attribution">{PLATFORM_ATTRIBUTION}</footer>
    </div>
  );
}
