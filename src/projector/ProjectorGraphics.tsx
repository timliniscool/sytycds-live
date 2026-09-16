import { useMemo } from "react";

import type { EmergencyPresentation, PublicAct } from "../../shared/domain";
import { actIdentity } from "../../shared/act-identity";
import { encodeQr, qrPath } from "./qr";

/** Quiet zone in modules, as required for a scannable symbol. */
const QUIET_ZONE = 4;

export function JoinCode({
  url,
  className = "lobby__qr",
}: {
  url: string;
  className?: string;
}) {
  // Encoding walks eight mask candidates, so it is computed once per URL
  // rather than on every projector re-render.
  const code = useMemo(() => {
    try {
      return encodeQr(url);
    } catch {
      return null;
    }
  }, [url]);

  if (!code) {
    return <p className="lobby__qr-fallback">{displayUrl(url)}</p>;
  }
  const span = code.size + QUIET_ZONE * 2;
  // Pure black on pure white, square corners, no logo: every one of those
  // would cost scan reliability from the back of a hall.
  return (
    <svg
      className={className}
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label={`Voting link: ${displayUrl(url)}`}
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="#ffffff" />
      <g transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`}>
        <path d={qrPath(code)} fill="#000000" />
      </g>
    </svg>
  );
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
}

export function LobbyGraphic({
  title,
  tagline,
  joinUrl,
}: {
  title: string;
  tagline: string;
  joinUrl: string;
}) {
  return (
    <section className="stage lobby" key="lobby">
      <div className="lobby__identity">
        <p className="stage__kicker">Live tonight</p>
        <h1 className="lobby__title">{title}</h1>
        {tagline && <p className="lobby__tagline">{tagline}</p>}
      </div>
      <div className="lobby__join">
        <JoinCode url={joinUrl} />
        <p className="lobby__scan">Scan to vote</p>
        <p className="lobby__url">{displayUrl(joinUrl)}</p>
      </div>
    </section>
  );
}

export function ActCardGraphic({ act }: { act: PublicAct }) {
  const identity = actIdentity(act);
  return (
    <section className="stage act-card" key={act.id}>
      {act.publicImageAssetId && (
        <img
          className="act-card__image"
          src={`/api/public/media/${encodeURIComponent(act.publicImageAssetId)}`}
          alt=""
        />
      )}
      <div className="act-card__copy">
        <p className="stage__kicker">
          Act {String(act.order + 1).padStart(2, "0")}
        </p>
        <h1 className="act-card__performer">{act.actName}</h1>
        <p className="act-card__name">{identity.primary}</p>
        {identity.secondary && (
          <p className="act-card__members">{identity.secondary}</p>
        )}
        <p className="act-card__meta">
          <span>{act.schoolYear}</span>
          <i aria-hidden="true" />
          <span>{act.actType}</span>
        </p>
        {act.publicDescription && (
          <p className="act-card__description">{act.publicDescription}</p>
        )}
      </div>
    </section>
  );
}

/**
 * Every act's Performance screen, drawn from the act itself. No cue, no upload
 * and no authoring is required for an act to look finished on a projector.
 *
 * Typography is clamped against the stage unit rather than the viewport, so the
 * same balanced composition holds at 1920x1080 and 1280x720 and one long word
 * never grows to fill half the screen.
 */
export function PerformanceGraphic({ act }: { act: PublicAct }) {
  const identity = actIdentity(act);
  return (
    <section className="stage performance" key={act.id}>
      {act.publicImageAssetId && (
        <img
          className="performance__image"
          src={`/api/public/media/${encodeURIComponent(act.publicImageAssetId)}`}
          alt=""
        />
      )}
      <div className="performance__copy">
        <h1 className="performance__act">{act.actName}</h1>
        <p className="performance__performer">{identity.primary}</p>
        {identity.secondary && (
          <p className="performance__members">{identity.secondary}</p>
        )}
        <p className="performance__meta">
          <span>{act.schoolYear}</span>
          {act.actType && (
            <>
              <i aria-hidden="true" />
              <span>{act.actType}</span>
            </>
          )}
        </p>
      </div>
    </section>
  );
}

export function HoldingGraphic({
  kicker,
  headline,
  detail,
}: {
  kicker: string;
  headline: string;
  detail?: string;
}) {
  return (
    <section className="stage holding" key={headline}>
      <p className="stage__kicker">{kicker}</p>
      <h1 className="holding__headline">{headline}</h1>
      {detail && <p className="holding__detail">{detail}</p>}
    </section>
  );
}

/** A cue-driven caption on black; the visual channel's own title card. */
export function TitleCardGraphic({ title }: { title: string }) {
  return (
    <section className="stage title-card" key={title}>
      <h1 className="title-card__title">{title}</h1>
    </section>
  );
}

export function IntermissionGraphic({ message }: { message: string }) {
  return (
    <section className="stage holding intermission" key="intermission">
      <p className="stage__kicker">Back shortly</p>
      <h1 className="holding__headline">Intermission</h1>
      {message && <p className="holding__detail">{message}</p>}
    </section>
  );
}

/** Calm and static: a technical hold should not look like a graphic. */
export function HoldGraphic() {
  return (
    <section className="stage holding hold" key="hold">
      <p className="stage__kicker">One moment</p>
      <h1 className="holding__headline">Please stand by</h1>
    </section>
  );
}

/**
 * Nothing moves and nothing decorates. BLACK is exactly that; TEXT is the
 * operator's message, or a plain instruction when none is configured.
 */
export function EmergencyGraphic({
  presentation,
  message,
}: {
  presentation: EmergencyPresentation;
  message: string;
}) {
  if (presentation === "BLACK") {
    return <section className="stage emergency emergency--black" />;
  }
  return (
    <section className="stage emergency" key="emergency-text">
      <h1 className="emergency__headline">
        {message || "Please follow staff instructions"}
      </h1>
    </section>
  );
}
