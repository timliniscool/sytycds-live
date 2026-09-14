import { useMemo } from "react";

import type { PublicAct } from "../../shared/domain";
import { encodeQr, qrPath } from "./qr";

/** Quiet zone in modules, as required for a scannable symbol. */
const QUIET_ZONE = 4;

export function JoinCode({ url }: { url: string }) {
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
  return (
    <svg
      className="lobby__qr"
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

export function displayUrl(url: string): string {
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
  return (
    <section className="stage act-card" key={act.id}>
      <p className="stage__kicker">
        Act {String(act.order + 1).padStart(2, "0")}
      </p>
      <h1 className="act-card__performer">{act.performerName}</h1>
      <p className="act-card__name">{act.actName}</p>
      <p className="act-card__meta">
        <span>{act.schoolYear}</span>
        <i aria-hidden="true" />
        <span>{act.actType}</span>
      </p>
      {act.publicDescription && (
        <p className="act-card__description">{act.publicDescription}</p>
      )}
    </section>
  );
}

export function HoldingGraphic({
  kicker,
  headline,
}: {
  kicker: string;
  headline: string;
}) {
  return (
    <section className="stage holding" key={headline}>
      <p className="stage__kicker">{kicker}</p>
      <h1 className="holding__headline">{headline}</h1>
    </section>
  );
}
