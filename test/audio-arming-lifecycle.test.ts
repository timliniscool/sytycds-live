import { describe, expect, it } from "vitest";

import type { ProjectorCue } from "../shared/domain";
import {
  ARM_REQUIRED,
  ProjectorMediaEngine,
  type ProjectorRuntime,
} from "../src/projector/MediaEngine";

/**
 * A media element that behaves like the browser's for everything the engine
 * touches: play() may be refused, events fire the way real ones do, and a
 * source swap while playing aborts the play() promise.
 */
class FakeAudio {
  paused = true;
  ended = false;
  currentTime = 0;
  volume = 1;
  muted = false;
  src = "";
  preload = "";
  readyState = 0;
  plays = 0;
  refuse: string | null = null;
  /** Resolve play() only when released, to model an asynchronous browser. */
  holdPlay = false;
  private pendingPlay: { resolve(): void; reject(error: Error): void } | null =
    null;
  private listeners = new Map<string, Set<() => void>>();

  play(): Promise<void> {
    this.plays += 1;
    if (this.refuse) {
      const error = new Error(this.refuse);
      error.name = this.refuse;
      return Promise.reject(error);
    }
    if (this.holdPlay) {
      return new Promise<void>((resolve, reject) => {
        this.pendingPlay = {
          resolve: () => {
            this.paused = false;
            this.fire("playing");
            resolve();
          },
          reject,
        };
      });
    }
    this.paused = false;
    this.fire("playing");
    return Promise.resolve();
  }
  releasePlay(): void {
    this.pendingPlay?.resolve();
    this.pendingPlay = null;
  }
  pause(): void {
    if (!this.paused) {
      this.paused = true;
      this.fire("pause");
    }
  }
  load(): void {
    if (this.pendingPlay) {
      const error = new Error("The play() request was interrupted");
      error.name = "AbortError";
      this.pendingPlay.reject(error);
      this.pendingPlay = null;
    }
    this.readyState = this.src ? 1 : 0;
  }
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeAudioContext {
  state = "suspended";
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const CUE: ProjectorCue = {
  id: "cue-1",
  actId: "act-1",
  position: 0,
  operatorLabel: "PERFORMANCE",
  origin: "SIMPLE",
  durationMs: null,
  operations: [{ kind: "audio", action: "LOAD", assetId: "asset-1" }],
  visual: null,
  audio: { sourceKey: "asset-1" },
} as unknown as ProjectorCue;

function runtime(overrides: Record<string, unknown> = {}): ProjectorRuntime {
  return {
    preparedCueId: null,
    activeVisualCueId: null,
    activeAudioCueId: null,
    visualTransport: "STOPPED",
    audioTransport: "STOPPED",
    blackScreen: false,
    emergencyPresentation: "BLACK",
    ...overrides,
  } as ProjectorRuntime;
}

function withFakeContext<Value>(run: () => Promise<Value>): Promise<Value> {
  const scope = globalThis as {
    AudioContext?: unknown;
    HTMLVideoElement?: unknown;
  };
  const previous = scope.AudioContext;
  const previousVideo = scope.HTMLVideoElement;
  scope.AudioContext = FakeAudioContext;
  // The engine asks `instanceof HTMLVideoElement`; the worker runtime has none.
  scope.HTMLVideoElement ??= class {};
  return run().finally(() => {
    scope.AudioContext = previous;
    scope.HTMLVideoElement = previousVideo;
  });
}

function engineWith(audio: FakeAudio) {
  const statuses: { armed: boolean; audio: string; error: string | null }[] =
    [];
  const engine = new ProjectorMediaEngine(
    {
      onStatus: (status) =>
        statuses.push({
          armed: status.armed,
          audio: status.audio,
          error: status.error,
        }),
      onAcknowledgement: () => undefined,
    },
    audio as unknown as HTMLAudioElement,
  );
  return { engine, statuses };
}

describe("projector audio lifecycle", () => {
  it("does not let a cue loading during the arming probe break either", () =>
    withFakeContext(async () => {
      const audio = new FakeAudio();
      audio.holdPlay = true;
      const { engine } = engineWith(audio);
      const arming = engine.arm();
      // The operator's PREPARE lands while the probe is still in flight.
      const playing = runtime({
        activeAudioCueId: "cue-1",
        audioTransport: "PLAYING",
      });
      const reconciled = engine.reconcile(playing, [CUE]);
      audio.releasePlay();
      expect(await arming).toBe(true);
      await reconciled;
      // The probe did not wipe the track, and the track is what is loaded.
      expect(audio.src).toContain("asset-1");
      expect(engine.isArmed()).toBe(true);
    }));

  it("reports the state before the probe, never the probe's own playback", () =>
    withFakeContext(async () => {
      const audio = new FakeAudio();
      const { engine, statuses } = engineWith(audio);
      // A track is loaded and paused; the operator arms afterwards.
      await engine.reconcile(
        runtime({ activeAudioCueId: "cue-1", audioTransport: "PAUSED" }),
        [CUE],
      );
      const before = engine.telemetry().audio;
      statuses.length = 0;
      expect(await engine.arm()).toBe(true);
      expect(statuses.some((status) => status.audio === "PLAYING")).toBe(false);
      expect(engine.telemetry().audio).toBe(before);
      expect(audio.paused).toBe(true);
    }));

  it("drops armed when the browser withdraws permission instead of faking PLAYING", () =>
    withFakeContext(async () => {
      const audio = new FakeAudio();
      const { engine } = engineWith(audio);
      expect(await engine.arm()).toBe(true);
      // Leave the fresh-session hold behind with a real operator command.
      await engine.execute(
        {
          type: "media_command",
          executionId: "exec-1",
          action: "stop_all",
          cueId: null,
        } as never,
        runtime(),
        [CUE],
      );
      audio.refuse = "NotAllowedError";
      // Arming trouble is reported, not thrown: the projector keeps running.
      await engine.reconcile(
        runtime({ activeAudioCueId: "cue-1", audioTransport: "PLAYING" }),
        [CUE],
      );
      expect(engine.isArmed()).toBe(false);
      expect(engine.telemetry().error).toBe(ARM_REQUIRED);
      expect(engine.telemetry().audio).not.toBe("PLAYING");
      // Re-arming from a new gesture recovers.
      audio.refuse = null;
      expect(await engine.arm()).toBe(true);
      expect(engine.isArmed()).toBe(true);
    }));

  it("plays, pauses, resumes and stops one element without duplicates", () =>
    withFakeContext(async () => {
      const audio = new FakeAudio();
      const { engine } = engineWith(audio);
      expect(await engine.arm()).toBe(true);
      const probePlays = audio.plays;
      const cues = [CUE];
      const play = runtime({
        activeAudioCueId: "cue-1",
        audioTransport: "PLAYING",
      });
      await engine.execute(
        {
          type: "media_command",
          executionId: "exec-play",
          action: "play",
          cueId: "cue-1",
        } as never,
        play,
        cues,
      );
      // The same state arriving again as a snapshot starts nothing twice.
      await engine.reconcile(play, cues);
      await engine.reconcile(play, cues);
      expect(audio.plays - probePlays).toBe(1);
      expect(engine.telemetry().audio).toBe("PLAYING");

      const paused = runtime({
        activeAudioCueId: "cue-1",
        audioTransport: "PAUSED",
      });
      await engine.reconcile(paused, cues);
      expect(audio.paused).toBe(true);
      expect(engine.telemetry().audio).toBe("PAUSED");

      await engine.reconcile(play, cues);
      expect(audio.paused).toBe(false);
      expect(audio.plays - probePlays).toBe(2);

      await engine.reconcile(runtime(), cues);
      expect(audio.paused).toBe(true);
      expect(audio.src).toBe("");
      expect(engine.telemetry().audio).toBe("IDLE");

      // Re-arming later is harmless and keeps the element unlocked.
      expect(await engine.arm()).toBe(true);
    }));

  it("forgets audio staged for an act that is no longer current", () =>
    withFakeContext(async () => {
      const audio = new FakeAudio();
      const { engine } = engineWith(audio);
      const created: HTMLAudioElement[] = [];
      const scope = globalThis as { Audio?: unknown };
      const previousAudio = scope.Audio;
      scope.Audio = class {
        preload = "";
        src = "";
        load(): void {}
        removeAttribute(): void {
          this.src = "";
        }
        constructor() {
          created.push(this as unknown as HTMLAudioElement);
        }
      };
      try {
        await engine.execute(
          {
            type: "media_command",
            executionId: "exec-prep",
            action: "prepare",
            cueId: "cue-1",
          } as never,
          runtime({ preparedCueId: "cue-1" }),
          [CUE],
        );
        expect(created).toHaveLength(1);
        expect(created[0]?.src).toContain("asset-1");
        // The next act has no cue for that asset: the staged element is let go.
        await engine.reconcile(runtime(), []);
        expect(created[0]?.src).toBe("");
      } finally {
        scope.Audio = previousAudio;
      }
    }));
});
