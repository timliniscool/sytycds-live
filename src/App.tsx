import { useEffect, useState } from "react";

type RuntimeStatus =
  | { state: "checking" }
  | { state: "ready"; storage: string }
  | { state: "unavailable" };

interface HealthResponse {
  ok: true;
  coordinator: {
    ok: true;
    storage: string;
  };
}

export function App() {
  const [status, setStatus] = useState<RuntimeStatus>({ state: "checking" });

  useEffect(() => {
    const controller = new AbortController();

    async function checkRuntime() {
      try {
        const response = await fetch("/api/health", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Health check failed with ${response.status}`);
        }

        const result = (await response.json()) as HealthResponse;
        setStatus({ state: "ready", storage: result.coordinator.storage });
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setStatus({ state: "unavailable" });
      }
    }

    void checkRuntime();
    return () => controller.abort();
  }, []);

  return (
    <main>
      <p className="eyebrow">So You Think You Can Do Stuff</p>
      <h1>Runtime baseline</h1>
      <p className={`status status--${status.state}`} role="status">
        <span aria-hidden="true" />
        {status.state === "checking" && "Checking Worker runtime…"}
        {status.state === "ready" &&
          `Worker and ${status.storage} coordinator ready`}
        {status.state === "unavailable" && "Worker runtime unavailable"}
      </p>
    </main>
  );
}
