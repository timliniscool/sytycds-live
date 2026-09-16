import type {
  MediaPlaybackState,
  ProjectorCue,
  ProjectorShowProjection,
  VisualCue,
} from "../../shared/domain";
import type {
  MediaCommandMessage,
  ProjectorPlaybackStatus,
} from "../../shared/protocol";
import { assetUrl } from "./media-cache";

export type PlaybackState = MediaPlaybackState;

export interface ProjectorMediaStatus {
  visual: PlaybackState;
  audio: PlaybackState;
  armed: boolean;
  black: boolean;
  error: string | null;
  /** An image or video frame is attached and ready to be seen. */
  hasFrame: boolean;
}

export interface MediaEngineOptions {
  onStatus(status: ProjectorMediaStatus): void;
  onAcknowledgement(
    executionId: string,
    succeeded: boolean,
    detail: string,
  ): void;
}

export type ProjectorRuntime = ProjectorShowProjection["runtime"];

interface Frame {
  cueId: string;
  assetId: string;
  element: HTMLImageElement | HTMLVideoElement;
}

interface StagedVisual {
  cueId: string;
  assetId: string;
  element: HTMLImageElement | HTMLVideoElement;
}

interface StagedAudio {
  assetId: string;
  element: HTMLAudioElement;
}

const LOAD_TIMEOUT_MS = 20_000;
const MAX_REMEMBERED_EXECUTIONS = 64;
export const ARM_REQUIRED = "ENABLE AUDIO & ENTER SHOW has not been pressed";

/** One sample of silence: enough for a real play() without a sound in the hall. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  const scope = globalThis as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function isMediaVisual(
  visual: VisualCue | null,
): visual is VisualCue & { sourceKey: string } {
  return (
    visual !== null &&
    visual.sourceKey !== null &&
    (visual.kind === "IMAGE" ||
      visual.kind === "SLIDES" ||
      visual.kind === "VIDEO")
  );
}

function withTimeout<Value>(
  promise: Promise<Value>,
  detail: string,
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(detail)), LOAD_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Loads an image entirely off-DOM so a failure can never show a broken icon. */
function loadImage(source: string, cover: boolean): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  image.draggable = false;
  image.className = `projector-media__image${cover ? " projector-media__image--cover" : ""}`;
  return withTimeout(
    new Promise<HTMLImageElement>((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("image failed to load"));
      image.src = source;
    }),
    "image load timed out",
  );
}

/** A video element with every public control surface removed. */
function createVideo(source: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.className = "projector-media__video";
  video.preload = "auto";
  video.playsInline = true;
  video.controls = false;
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.setAttribute(
    "controlslist",
    "nodownload nofullscreen noremoteplayback",
  );
  video.src = source;
  return video;
}

function loadVideo(source: string): Promise<HTMLVideoElement> {
  const video = createVideo(source);
  return withTimeout(
    new Promise<HTMLVideoElement>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(video), {
        once: true,
      });
      video.addEventListener(
        "error",
        () => reject(new Error("video failed to load")),
        { once: true },
      );
      video.load();
    }),
    "video load timed out",
  );
}

/**
 * Owns the browser media elements outside React and converges them on the
 * authoritative runtime. Commands add only what state cannot express (a seek,
 * a restart from the top); everything else is a reconcile, so a reconnect or a
 * replayed message can never restart media that already matches the server.
 */
export class ProjectorMediaEngine {
  private host: HTMLElement | null = null;
  /**
   * One element for the whole page session. Browsers grant playback permission
   * per element, so replacing it on every cue would silently re-lock the show's
   * backing audio after arming; only its `src` ever changes.
   */
  private readonly audio: HTMLAudioElement;
  private audioContext: AudioContext | null = null;
  private audioAssetId: string | null = null;
  private frame: Frame | null = null;
  private stagedVisual: StagedVisual | null = null;
  private stagedAudio: StagedAudio | null = null;
  private lastTarget: {
    runtime: ProjectorRuntime;
    cues: readonly ProjectorCue[];
  } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly executed = new Set<string>();
  private playbackExecutionId: string | null = null;
  private armed = false;
  private black = false;
  private visual: PlaybackState = "IDLE";
  private audioState: PlaybackState = "IDLE";
  private error: string | null = null;
  private disposed = false;
  /**
   * True until the first operator command of this page session. State that
   * says PLAYING is honoured for anything already audible, but after a reload
   * nothing is audible, and restarting a backing track from the top mid-act is
   * worse than silence. So a fresh session loads and holds; RESUME or REPLAY
   * is the operator saying which they want.
   */
  private freshSession = true;
  private held = false;
  /**
   * The arming probe in flight. Reconciles wait for it so a cue that loads
   * while the operator is pressing ENABLE AUDIO cannot yank the element's
   * source out from under the probe (which would both fail the probe and
   * leave the freshly loaded track unloaded).
   */
  private arming: Promise<void> | null = null;
  /** The probe plays the element silently; its events are not real playback. */
  private probing = false;

  constructor(
    private readonly options: MediaEngineOptions,
    /** Injectable so the arming sequence can be tested without a browser. */
    audioElement: HTMLAudioElement = new Audio(),
  ) {
    this.audio = audioElement;
    this.bindAudio();
  }

  attach(host: HTMLElement): void {
    this.host = host;
    if (this.frame && !this.frame.element.isConnected)
      host.appendChild(this.frame.element);
  }

  /**
   * Must be called from a real click *in this browser*. A click on the
   * operator's machine is not a user gesture here, so nothing the admin console
   * does can arm the hall; only the projector itself can.
   *
   * Two things are actually unlocked, and `armed` is set only if both succeed:
   * the Web Audio context (which starts suspended until a gesture resumes it)
   * and the very element that will carry the show's backing audio (on iOS the
   * permission is granted per element, so unlocking a throwaway probe proves
   * nothing). The test plays unmuted at zero volume: muted playback is exempt
   * from the autoplay policy and would therefore always "succeed".
   *
   * Both gesture-sensitive calls — `AudioContext.resume()` and
   * `HTMLMediaElement.play()` — are issued *synchronously, in the click's own
   * call stack*, before anything is awaited. Awaiting the context first and
   * then calling `play()` looked correct but left `play()` running after an
   * asynchronous boundary; browsers that scope user activation to the gesture's
   * task (Safari, and Chromium once activation has been consumed) then refused
   * it, which is exactly the "works on the second click" symptom.
   */
  async arm(): Promise<boolean> {
    // A second press while the first probe is still running has no gesture of
    // its own to spend; it simply reports the first probe's answer.
    if (this.arming) {
      await this.arming;
      return this.armed;
    }
    const contextAttempt = this.resumeAudioContext();
    const elementAttempt = this.unlockAudioElement();
    const settled = Promise.all([contextAttempt, elementAttempt]);
    this.arming = settled.then(
      () => undefined,
      () => undefined,
    );
    // Anything queued behind this point waits for the probe to finish.
    void this.enqueue(() => this.arming ?? Promise.resolve());
    try {
      const [context, element] = await settled;
      if (!context.ok || !element.ok) {
        this.armed = false;
        this.error = context.ok
          ? element.detail
          : element.ok
            ? context.detail
            : `${context.detail}; ${element.detail}`;
        this.emit();
        return false;
      }
      this.armed = true;
      if (this.error === ARM_REQUIRED) this.error = null;
      this.emit();
    } finally {
      this.arming = null;
    }
    if (this.lastTarget) {
      const { runtime, cues } = this.lastTarget;
      void this.reconcile(runtime, cues);
    }
    return true;
  }

  isArmed(): boolean {
    return this.armed;
  }

  /**
   * Starts resuming the context synchronously and returns the promise; the
   * caller must not await anything before also calling `unlockAudioElement`.
   */
  private resumeAudioContext(): Promise<{ ok: boolean; detail: string }> {
    const Constructor = audioContextConstructor();
    // A browser with no Web Audio can still play media elements; the element
    // test below is then the whole of the proof.
    if (!Constructor)
      return Promise.resolve({ ok: true, detail: "no Web Audio" });
    let resumed: Promise<void>;
    try {
      this.audioContext ??= new Constructor();
      resumed =
        this.audioContext.state === "running"
          ? Promise.resolve()
          : this.audioContext.resume();
    } catch (error: unknown) {
      return Promise.resolve({
        ok: false,
        detail:
          error instanceof Error
            ? error.message
            : "audio context could not start",
      });
    }
    const context = this.audioContext;
    return resumed.then(
      () =>
        context.state === "running"
          ? { ok: true, detail: "audio context running" }
          : { ok: false, detail: `audio context is ${context.state}` },
      (error: unknown) => ({
        ok: false,
        detail:
          error instanceof Error
            ? error.message
            : "audio context could not start",
      }),
    );
  }

  /**
   * Calls `play()` on the show's own audio element synchronously — the call
   * happens before this method returns — and resolves once the browser has
   * answered. Everything that must follow the answer (pausing, restoring the
   * position, detaching the probe source) happens after, where timing no
   * longer matters.
   */
  private unlockAudioElement(): Promise<{ ok: boolean; detail: string }> {
    const element = this.audio;
    // Already audible: the pipeline is demonstrably unlocked and must not be
    // interrupted to prove it again.
    if (!element.paused && !element.ended)
      return Promise.resolve({ ok: true, detail: "already playing" });
    const sourceAtStart = this.audioAssetId;
    const loadedSource = sourceAtStart !== null;
    const restoreTime = element.currentTime;
    const restoreVolume = element.volume;
    const restoreState = this.audioState;
    this.probing = true;
    element.muted = false;
    element.volume = 0;
    if (!loadedSource) element.src = SILENT_WAV;
    let played: Promise<void>;
    try {
      // `play()` may return undefined in very old engines; normalise.
      played = Promise.resolve(element.play());
    } catch (error: unknown) {
      played = Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    const restore = () => {
      element.volume = restoreVolume;
      // The probe's own playing/pause events were suppressed; the state the
      // engine reports is the state before the probe.
      this.audioState = restoreState;
      this.probing = false;
    };
    // Only detach the probe's silent source if nothing real replaced it
    // meanwhile; a track loaded during the probe must survive it.
    const detachProbeSource = () => {
      if (this.audioAssetId !== null) return;
      element.removeAttribute("src");
      element.load();
    };
    return played.then(
      () => {
        // A real track that is meant to be playing stays playing; otherwise
        // the probe is undone completely.
        const shouldKeepPlaying =
          loadedSource &&
          this.audioAssetId === sourceAtStart &&
          this.lastTarget?.runtime.audioTransport === "PLAYING" &&
          !this.freshSession;
        if (!shouldKeepPlaying) element.pause();
        if (loadedSource) {
          if (!shouldKeepPlaying) element.currentTime = restoreTime;
        } else {
          detachProbeSource();
        }
        restore();
        if (shouldKeepPlaying) this.audioState = "PLAYING";
        return { ok: true, detail: "media element unlocked" };
      },
      (error: unknown) => {
        if (!loadedSource) detachProbeSource();
        restore();
        return {
          ok: false,
          detail:
            error instanceof Error
              ? error.message
              : "browser refused to enable audio",
        };
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.releaseAudio();
    this.clearFrame();
    this.stagedVisual = null;
    this.stagedAudio?.element.removeAttribute("src");
    this.stagedAudio = null;
    this.host = null;
  }

  isReady(): boolean {
    return this.host !== null && !this.disposed;
  }

  telemetry(): ProjectorPlaybackStatus {
    const video =
      this.frame?.element instanceof HTMLVideoElement
        ? this.frame.element
        : null;
    const timed = video ?? (this.audioAssetId ? this.audio : null);
    const duration =
      timed && Number.isFinite(timed.duration)
        ? Math.round(timed.duration * 1000)
        : null;
    return {
      visual: this.visual,
      audio: this.audioState,
      positionMs: timed ? Math.round(timed.currentTime * 1000) : null,
      durationMs: duration,
      armed: this.armed,
      black: this.black,
      error: this.error,
      ...(this.held ? { held: true } : {}),
    };
  }

  /** Converge on authoritative state. Safe to call on every snapshot. */
  reconcile(
    runtime: ProjectorRuntime,
    cues: readonly ProjectorCue[],
  ): Promise<void> {
    return this.enqueue(() => this.apply(runtime, cues));
  }

  /**
   * Executes an operator command exactly once. The state patch carrying the
   * same revision has already landed in `runtime`, so most actions are a
   * reconcile plus an acknowledgement.
   */
  execute(
    command: MediaCommandMessage,
    runtime: ProjectorRuntime,
    cues: readonly ProjectorCue[],
  ): Promise<void> {
    if (this.executed.has(command.executionId)) return Promise.resolve();
    this.remember(command.executionId);
    return this.enqueue(async () => {
      this.error = null;
      this.freshSession = false;
      this.held = false;
      const cue = command.cueId
        ? (cues.find((candidate) => candidate.id === command.cueId) ?? null)
        : null;
      try {
        switch (command.action) {
          case "prepare":
          case "next":
          case "previous":
            await this.stage(cue);
            this.ack(command.executionId, true, "PREPARED");
            return;
          case "play":
            this.playbackExecutionId = command.executionId;
            this.restartChannelsOf(cue);
            await this.apply(runtime, cues);
            this.applyCueTransportOperation(cue);
            this.ack(command.executionId, true, this.startedDetail());
            return;
          case "restart":
            this.playbackExecutionId = command.executionId;
            this.rewindVideo();
            if (this.audioAssetId) this.audio.currentTime = 0;
            await this.apply(runtime, cues);
            this.ack(command.executionId, true, this.startedDetail());
            return;
          case "replay":
            this.playbackExecutionId = command.executionId;
            if (!this.audioAssetId)
              throw new Error("no backing audio is loaded");
            this.audio.currentTime = 0;
            await this.apply(runtime, cues);
            this.ack(command.executionId, true, this.startedDetail());
            return;
          case "seek": {
            const seconds = (command.positionMs ?? 0) / 1000;
            if (this.frame?.element instanceof HTMLVideoElement)
              this.frame.element.currentTime = seconds;
            if (this.audioAssetId) this.audio.currentTime = seconds;
            await this.apply(runtime, cues);
            this.ack(command.executionId, true, "SEEKED");
            return;
          }
          case "pause":
            await this.apply(runtime, cues);
            this.ack(command.executionId, true, "PAUSED");
            return;
          case "resume":
            this.playbackExecutionId = command.executionId;
            await this.apply(runtime, cues);
            this.ack(command.executionId, true, this.startedDetail());
            return;
          case "stop":
          case "stop_all":
            await this.apply(runtime, cues);
            this.ack(command.executionId, true, "STOPPED");
            return;
          case "black":
            await this.apply(runtime, cues);
            this.ack(
              command.executionId,
              true,
              runtime.blackScreen ? "BLACK" : "VISIBLE",
            );
            return;
        }
      } catch (error: unknown) {
        const detail =
          error instanceof Error ? error.message : "media command failed";
        this.fail(detail);
        this.ack(command.executionId, false, detail);
      }
    });
  }

  private startedDetail(): string {
    return this.error === ARM_REQUIRED ? "LOADED, NOT ARMED" : "STARTED";
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private remember(executionId: string): void {
    this.executed.add(executionId);
    if (this.executed.size > MAX_REMEMBERED_EXECUTIONS) {
      const oldest = this.executed.values().next().value;
      if (oldest) this.executed.delete(oldest);
    }
  }

  /** The commanded cue starts from the top on its own channels only. */
  private restartChannelsOf(cue: ProjectorCue | null): void {
    if (!cue) return;
    if (
      cue.audio &&
      this.audioAssetId === cue.audio.sourceKey &&
      this.audio.readyState > 0
    ) {
      this.audio.currentTime = 0;
    }
    if (
      cue.visual?.kind === "VIDEO" &&
      this.frame?.cueId === cue.id &&
      this.frame.element instanceof HTMLVideoElement
    ) {
      this.frame.element.currentTime = 0;
    }
  }

  /** Apply the transient part of a cue that cannot be reconstructed from state. */
  private applyCueTransportOperation(cue: ProjectorCue | null): void {
    if (!cue) return;
    for (const operation of cue.operations) {
      if (operation.kind !== "audio") continue;
      if (operation.action === "REPLAY" && this.audioAssetId)
        this.audio.currentTime = 0;
      if (operation.action === "SEEK" && this.audioAssetId)
        this.audio.currentTime = (operation.positionMs ?? 0) / 1_000;
    }
  }

  private rewindVideo(): void {
    if (this.frame?.element instanceof HTMLVideoElement)
      this.frame.element.currentTime = 0;
  }

  private async apply(
    runtime: ProjectorRuntime,
    cues: readonly ProjectorCue[],
  ): Promise<void> {
    if (this.disposed) return;
    this.lastTarget = { runtime, cues };
    if (this.arming) await this.arming;
    this.black = runtime.blackScreen;
    this.held = false;
    let failure: string | null = null;

    const visualCue =
      cues.find((cue) => cue.id === runtime.activeVisualCueId) ?? null;
    const visual = visualCue?.visual ?? null;
    if (
      !visualCue ||
      runtime.visualTransport === "STOPPED" ||
      !isMediaVisual(visual)
    ) {
      // Title cards, CLEAR and BLACK are drawn by the graphics layer; the
      // engine only ever owns image and video frames.
      this.clearFrame();
    } else {
      if (
        this.frame?.cueId !== visualCue.id ||
        this.frame.assetId !== visual.sourceKey
      ) {
        try {
          await this.showVisual(visualCue, visual);
        } catch (error: unknown) {
          // The previous frame stays up: a failed swap is reported, never
          // shown as a black hole or a broken icon.
          failure =
            error instanceof Error ? error.message : "visual failed to load";
        }
      }
      if (this.frame?.element instanceof HTMLVideoElement) {
        await this.applyTransport(
          this.frame.element,
          runtime.visualTransport,
          (detail) => {
            failure ??= detail;
          },
        );
      } else if (this.frame) {
        this.visual =
          runtime.visualTransport === "PAUSED" ? "PAUSED" : "LOADED";
      }
    }

    // Staged audio that no cue of this act refers to any more belongs to a
    // previous act; drop it so an act change leaves nothing stale behind.
    if (
      this.stagedAudio &&
      !cues.some((cue) => cue.audio?.sourceKey === this.stagedAudio?.assetId)
    ) {
      this.stagedAudio.element.removeAttribute("src");
      this.stagedAudio.element.load();
      this.stagedAudio = null;
    }

    const audioCue =
      cues.find((cue) => cue.id === runtime.activeAudioCueId) ?? null;
    if (!audioCue?.audio || runtime.audioTransport === "STOPPED") {
      this.unloadAudio();
    } else {
      if (this.audioAssetId !== audioCue.audio.sourceKey) {
        this.loadAudio(audioCue.audio.sourceKey);
      }
      await this.applyTransport(
        this.audio,
        runtime.audioTransport,
        (detail) => {
          failure ??= detail;
        },
      );
    }

    if (failure) this.error = failure;
    this.emit();
    if (failure && failure !== ARM_REQUIRED) throw new Error(failure);
  }

  private async applyTransport(
    element: HTMLMediaElement,
    transport: ProjectorRuntime["audioTransport"],
    report: (detail: string) => void,
  ): Promise<void> {
    if (transport === "PLAYING") {
      if (!element.paused && !element.ended) return;
      if (this.freshSession) {
        this.held = true;
        return;
      }
      if (!this.armed) {
        report(ARM_REQUIRED);
        return;
      }
      try {
        await element.play();
      } catch (error: unknown) {
        // The browser withdrew playback permission (a new document, a
        // consumed activation): the engine is no longer armed, whatever it
        // believed, and says so rather than reporting a phantom PLAYING.
        if ((error as { name?: string } | null)?.name === "NotAllowedError") {
          this.armed = false;
          report(ARM_REQUIRED);
          return;
        }
        report(error instanceof Error ? error.message : "playback refused");
      }
      return;
    }
    if (!element.paused) element.pause();
  }

  /** Preloads a cue's media without touching what is on screen or audible. */
  private async stage(cue: ProjectorCue | null): Promise<void> {
    if (!cue) throw new Error("cue is unavailable");
    const visual = cue.visual;
    if (isMediaVisual(visual)) {
      const alreadyShown =
        this.frame?.cueId === cue.id && this.frame.assetId === visual.sourceKey;
      const alreadyStaged =
        this.stagedVisual?.cueId === cue.id &&
        this.stagedVisual.assetId === visual.sourceKey;
      if (!alreadyShown && !alreadyStaged) {
        const element =
          visual.kind === "VIDEO"
            ? await loadVideo(assetUrl(visual.sourceKey))
            : await loadImage(
                assetUrl(visual.sourceKey),
                visual.fit === "cover",
              );
        this.stagedVisual = {
          cueId: cue.id,
          assetId: visual.sourceKey,
          element,
        };
      }
    }
    if (cue.audio && this.audioAssetId !== cue.audio.sourceKey) {
      if (this.stagedAudio?.assetId !== cue.audio.sourceKey) {
        // One staged element at a time; the previous one gives up its download.
        if (this.stagedAudio) {
          this.stagedAudio.element.removeAttribute("src");
          this.stagedAudio.element.load();
        }
        const element = new Audio();
        element.preload = "auto";
        element.src = assetUrl(cue.audio.sourceKey);
        element.load();
        this.stagedAudio = { assetId: cue.audio.sourceKey, element };
      }
    }
    this.emit();
  }

  /** Swaps the frame only once the replacement is ready, so nothing flashes. */
  private async showVisual(
    cue: ProjectorCue,
    visual: VisualCue & { sourceKey: string },
  ): Promise<void> {
    let element: HTMLImageElement | HTMLVideoElement;
    if (
      this.stagedVisual?.cueId === cue.id &&
      this.stagedVisual.assetId === visual.sourceKey
    ) {
      element = this.stagedVisual.element;
      this.stagedVisual = null;
    } else {
      element =
        visual.kind === "VIDEO"
          ? await loadVideo(assetUrl(visual.sourceKey))
          : await loadImage(assetUrl(visual.sourceKey), visual.fit === "cover");
    }
    if (this.disposed) return;
    const previous = this.frame;
    this.frame = { cueId: cue.id, assetId: visual.sourceKey, element };
    if (element instanceof HTMLVideoElement) this.bindVideo(element);
    this.host?.appendChild(element);
    if (previous) {
      if (previous.element instanceof HTMLVideoElement)
        previous.element.pause();
      previous.element.remove();
    }
    this.visual = "LOADED";
  }

  private bindVideo(video: HTMLVideoElement): void {
    const current = () => this.frame?.element === video;
    video.addEventListener("playing", () => {
      if (current()) this.setVisual("PLAYING");
    });
    video.addEventListener("pause", () => {
      if (current()) this.setVisual(video.ended ? "ENDED" : "PAUSED");
    });
    video.addEventListener("ended", () => {
      if (current()) {
        this.setVisual("ENDED");
        if (this.playbackExecutionId)
          this.ack(this.playbackExecutionId, true, "ENDED");
      }
    });
    video.addEventListener("error", () => {
      if (current()) this.fail("video media error");
    });
  }

  private clearFrame(): void {
    if (!this.frame) return;
    if (this.frame.element instanceof HTMLVideoElement)
      this.frame.element.pause();
    this.frame.element.remove();
    this.frame = null;
    this.visual = "IDLE";
  }

  /**
   * Points the one unlocked element at a new asset. Staging warmed the browser
   * cache, so this is a cache read rather than a second download.
   */
  private loadAudio(assetId: string): void {
    this.releaseAudio();
    if (this.stagedAudio?.assetId === assetId) {
      this.stagedAudio.element.removeAttribute("src");
      this.stagedAudio = null;
    }
    this.audio.preload = "auto";
    this.audio.src = assetUrl(assetId);
    this.audio.load();
    this.audioAssetId = assetId;
    this.audioState = "LOADED";
  }

  private unloadAudio(): void {
    if (!this.audioAssetId) return;
    this.releaseAudio();
    this.audioAssetId = null;
    this.audioState = "IDLE";
  }

  private releaseAudio(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }

  /** Bound once, because the element lives as long as the page does. */
  private bindAudio(): void {
    const audio = this.audio;
    audio.addEventListener("playing", () => {
      if (this.audioAssetId && !this.probing) this.setAudio("PLAYING");
    });
    audio.addEventListener("pause", () => {
      if (this.audioAssetId && !this.probing)
        this.setAudio(audio.ended ? "ENDED" : "PAUSED");
    });
    audio.addEventListener("ended", () => {
      if (!this.audioAssetId || this.probing) return;
      this.setAudio("ENDED");
      if (this.playbackExecutionId)
        this.ack(this.playbackExecutionId, true, "ENDED");
    });
    audio.addEventListener("error", () => {
      if (this.audioAssetId) this.fail("audio media error");
    });
  }

  private setVisual(state: PlaybackState): void {
    this.visual = state;
    this.emit();
  }

  private setAudio(state: PlaybackState): void {
    this.audioState = state;
    this.emit();
  }

  private fail(detail: string): void {
    this.error = detail;
    this.emit();
  }

  private ack(executionId: string, succeeded: boolean, detail: string): void {
    this.options.onAcknowledgement(executionId, succeeded, detail);
  }

  private emit(): void {
    if (this.disposed) return;
    this.options.onStatus({
      visual: this.visual,
      audio: this.audioState,
      armed: this.armed,
      black: this.black,
      error: this.error,
      hasFrame: this.frame !== null,
    });
  }
}
