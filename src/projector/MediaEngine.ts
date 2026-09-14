import type { PersistedCue } from "../../shared/domain";
import type { MediaCommandMessage } from "../../shared/protocol";

export type PlaybackState =
  "IDLE" | "LOADED" | "PLAYING" | "PAUSED" | "ENDED" | "ERROR";

export interface ProjectorMediaStatus {
  visual: PlaybackState;
  audio: PlaybackState;
  armed: boolean;
  black: boolean;
  error: string | null;
}

export interface MediaEngineOptions {
  onStatus(status: ProjectorMediaStatus): void;
  onAcknowledgement(
    executionId: string,
    succeeded: boolean,
    detail: string,
  ): void;
}

function assetUrl(assetId: string): string {
  return `/api/media/${encodeURIComponent(assetId)}`;
}

/**
 * Owns browser media elements outside React.  A newer server revision always
 * wins, so an asynchronous play/load from an old act cannot take over later.
 */
export class ProjectorMediaEngine {
  private readonly audio = new Audio();
  private video: HTMLVideoElement | null = null;
  private image: HTMLImageElement | null = null;
  private host: HTMLElement | null = null;
  private lastRevision = -1;
  private activeExecutionId: string | null = null;
  private armed = false;
  private black = false;
  private visual: PlaybackState = "IDLE";
  private audioState: PlaybackState = "IDLE";
  private error: string | null = null;

  constructor(private readonly options: MediaEngineOptions) {
    this.audio.preload = "auto";
    this.audio.addEventListener("playing", () => this.setAudio("PLAYING"));
    this.audio.addEventListener("pause", () =>
      this.setAudio(this.audio.ended ? "ENDED" : "PAUSED"),
    );
    this.audio.addEventListener("ended", () => this.setAudio("ENDED"));
    this.audio.addEventListener("error", () => this.fail("audio media error"));
  }

  attach(host: HTMLElement): void {
    this.host = host;
  }

  async arm(): Promise<boolean> {
    try {
      // A muted, user-initiated play unlocks the media pipeline without
      // producing sound. Future audible playback still reports real errors.
      this.audio.muted = true;
      await this.audio.play();
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.muted = false;
      this.armed = true;
      this.emit();
      return true;
    } catch {
      this.error = "Browser did not enable audio";
      this.emit();
      return false;
    }
  }

  setVolume(value: number): void {
    this.audio.volume = Math.max(0, Math.min(1, value));
    if (this.video) this.video.volume = this.audio.volume;
  }

  stopAll(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.stopVideo();
    this.removeImage();
    this.visual = "IDLE";
    this.audioState = "IDLE";
    this.black = false;
    this.emit();
  }

  dispose(): void {
    this.stopAll();
    this.host = null;
  }

  async execute(
    command: MediaCommandMessage,
    cue: PersistedCue | null,
  ): Promise<void> {
    if (Number(command.revision) < this.lastRevision) return;
    this.lastRevision = Number(command.revision);
    this.activeExecutionId = command.executionId;
    this.error = null;
    try {
      switch (command.action) {
        case "prepare":
          await this.prepare(cue);
          this.ack(command.executionId, true, "PREPARED");
          break;
        case "play":
          await this.play(cue);
          this.ack(command.executionId, true, "STARTED");
          break;
        case "pause":
          this.audio.pause();
          this.video?.pause();
          this.ack(command.executionId, true, "PAUSED");
          break;
        case "resume":
          await this.resume();
          this.ack(command.executionId, true, "STARTED");
          break;
        case "stop":
          this.stopAll();
          this.ack(command.executionId, true, "PAUSED");
          break;
        case "restart":
        case "replay":
          await this.restart();
          this.ack(command.executionId, true, "STARTED");
          break;
        case "seek":
          this.seek(command.positionMs ?? 0);
          this.ack(command.executionId, true, "STARTED");
          break;
        case "black":
          this.black = true;
          this.emit();
          this.ack(command.executionId, true, "PREPARED");
          break;
        case "next":
        case "previous":
          await this.prepare(cue);
          this.ack(command.executionId, true, "PREPARED");
          break;
      }
    } catch (error: unknown) {
      this.fail(
        error instanceof Error ? error.message : "media command failed",
      );
      this.ack(command.executionId, false, "ERROR");
    }
  }

  private async prepare(cue: PersistedCue | null): Promise<void> {
    if (!cue) throw new Error("cue is unavailable");
    this.black = false;
    if (cue.visual) await this.loadVisual(cue);
    // Deliberately do nothing to audio when the cue has no audio: visual cues
    // must not interrupt backing tracks.
    if (cue.audio) this.loadAudio(cue.audio.sourceKey);
    this.emit();
  }

  private async play(cue: PersistedCue | null): Promise<void> {
    if (cue) await this.prepare(cue);
    if (!this.armed && (this.audio.src || this.video))
      throw new Error("ARM SHOW / ENABLE AUDIO is required");
    const plays: Promise<void>[] = [];
    if (this.video) plays.push(this.video.play());
    if (this.audio.src) plays.push(this.audio.play());
    await Promise.all(plays);
    if (this.image) this.setVisual("PLAYING");
  }

  private async resume(): Promise<void> {
    if (!this.armed && (this.audio.src || this.video))
      throw new Error("ARM SHOW / ENABLE AUDIO is required");
    await Promise.all([
      this.video?.paused ? this.video.play() : Promise.resolve(),
      this.audio.paused && this.audio.src
        ? this.audio.play()
        : Promise.resolve(),
    ]);
  }

  private async restart(): Promise<void> {
    if (this.video) this.video.currentTime = 0;
    if (this.audio.src) this.audio.currentTime = 0;
    await this.resume();
  }

  private seek(positionMs: number): void {
    const seconds = positionMs / 1000;
    if (this.video?.readyState) this.video.currentTime = seconds;
    if (this.audio.readyState) this.audio.currentTime = seconds;
  }

  private async loadVisual(cue: PersistedCue): Promise<void> {
    const visual = cue.visual;
    if (!visual || visual.kind === "BLACK") {
      this.black = true;
      this.removeImage();
      this.stopVideo();
      return;
    }
    if (visual.kind === "CLEAR" || visual.kind === "TITLE_CARD") {
      this.removeImage();
      this.stopVideo();
      this.setVisual("LOADED");
      return;
    }
    if (!visual.sourceKey) throw new Error("visual asset is missing");
    if (visual.kind === "VIDEO") {
      this.removeImage();
      await this.loadVideo(assetUrl(visual.sourceKey));
      return;
    }
    this.stopVideo();
    await this.loadImage(assetUrl(visual.sourceKey));
  }

  private loadAudio(assetId: string): void {
    if (this.audio.src.endsWith(`/api/media/${encodeURIComponent(assetId)}`))
      return;
    this.audio.pause();
    this.audio.src = assetUrl(assetId);
    this.audio.load();
    this.setAudio("LOADED");
  }

  private loadImage(source: string): Promise<void> {
    this.removeImage();
    const image = new Image();
    image.className = "projector-media__image";
    this.image = image;
    this.host?.append(image);
    return new Promise((resolve, reject) => {
      image.onload = () => {
        this.setVisual("LOADED");
        resolve();
      };
      image.onerror = () => reject(new Error("image failed to load"));
      image.src = source;
    });
  }

  private loadVideo(source: string): Promise<void> {
    this.stopVideo();
    const video = document.createElement("video");
    video.className = "projector-media__video";
    video.preload = "auto";
    video.playsInline = true;
    video.volume = this.audio.volume;
    this.video = video;
    this.host?.append(video);
    video.addEventListener("playing", () => this.setVisual("PLAYING"));
    video.addEventListener("pause", () =>
      this.setVisual(video.ended ? "ENDED" : "PAUSED"),
    );
    video.addEventListener("ended", () => {
      this.setVisual("ENDED");
      this.emitEnded();
    });
    video.addEventListener("error", () => this.fail("video media error"));
    return new Promise((resolve, reject) => {
      video.oncanplay = () => {
        this.setVisual("LOADED");
        resolve();
      };
      video.onerror = () => reject(new Error("video failed to load"));
      video.src = source;
      video.load();
    });
  }

  private stopVideo(): void {
    if (!this.video) return;
    this.video.pause();
    this.video.remove();
    this.video = null;
  }
  private removeImage(): void {
    this.image?.remove();
    this.image = null;
  }
  private setVisual(state: PlaybackState): void {
    this.visual = state;
    this.emit();
  }
  private setAudio(state: PlaybackState): void {
    this.audioState = state;
    if (state === "ENDED") this.emitEnded();
    this.emit();
  }
  private fail(detail: string): void {
    this.error = detail;
    this.visual = this.video ? "ERROR" : this.visual;
    this.audioState = this.audio.error ? "ERROR" : this.audioState;
    this.emit();
  }
  private emitEnded(): void {
    if (this.activeExecutionId)
      this.options.onAcknowledgement(this.activeExecutionId, true, "ENDED");
  }
  private ack(executionId: string, succeeded: boolean, detail: string): void {
    this.options.onAcknowledgement(executionId, succeeded, detail);
  }
  private emit(): void {
    this.options.onStatus({
      visual: this.visual,
      audio: this.audioState,
      armed: this.armed,
      black: this.black,
      error: this.error,
    });
  }
}
