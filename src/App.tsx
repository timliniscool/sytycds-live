import { Component, lazy, Suspense, useEffect, type ReactNode } from "react";

import { metadataForRoute, resolveRoute, type Route } from "./router";

const AdminSurface = lazy(() => import("./surfaces/AdminSurface"));
const ProjectorSurface = lazy(() => import("./surfaces/ProjectorSurface"));
const VoteSurface = lazy(() => import("./surfaces/VoteSurface"));
const JudgeSurface = lazy(() => import("./surfaces/JudgeSurface"));

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

class SurfaceErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <FatalScreen title="Unable to start this show surface" />;
    }

    return this.props.children;
  }
}

function supportsRequiredBrowserFeatures(): boolean {
  return (
    typeof window.Promise !== "undefined" &&
    typeof window.fetch === "function" &&
    typeof window.WebSocket === "function" &&
    typeof window.crypto?.getRandomValues === "function"
  );
}

function RouteDocumentMetadata({ route }: { route: Route }) {
  useEffect(() => {
    const metadata = metadataForRoute(route);
    document.title = metadata.title;
    document.documentElement.style.setProperty(
      "--surface-theme",
      metadata.themeColor,
    );

    const description = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    description?.setAttribute("content", metadata.description);

    const themeColor = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    themeColor?.setAttribute("content", metadata.themeColor);
  }, [route]);

  return null;
}

function FatalScreen({ title }: { title: string }) {
  return (
    <main className="fatal-screen">
      <p>SYTYCDS</p>
      <h1>{title}</h1>
      <p>Please use a current browser, then reload this page.</p>
    </main>
  );
}

function NotFoundSurface() {
  return (
    <main className="not-found" aria-labelledby="not-found-title">
      <p>SYTYCDS</p>
      <h1 id="not-found-title">This show surface does not exist.</h1>
      <a href="/vote">Go to audience voting</a>
    </main>
  );
}

function Surface({ route }: { route: Route }) {
  switch (route.kind) {
    case "admin":
      return <AdminSurface />;
    case "projector":
      return <ProjectorSurface />;
    case "vote":
      return <VoteSurface />;
    case "judge":
      return <JudgeSurface token={route.token} />;
    case "not-found":
      return <NotFoundSurface />;
  }
}

export function App() {
  const route = resolveRoute(window.location.pathname);

  if (!supportsRequiredBrowserFeatures()) {
    return <FatalScreen title="This browser cannot run the live show" />;
  }

  return (
    <SurfaceErrorBoundary>
      <RouteDocumentMetadata route={route} />
      <Suspense fallback={<FatalScreen title="Starting show surface…" />}>
        <Surface route={route} />
      </Suspense>
    </SurfaceErrorBoundary>
  );
}
