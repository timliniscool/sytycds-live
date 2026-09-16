import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { describeOperation } from "./cue-language";
import type {
  ActPresentation,
  AdminAct,
  CueOperation,
  MediaAsset,
  MediaAssetReference,
  PerformanceVisualMode,
  Performer,
  PerformerDisplayMode,
  PersistedCue,
} from "../../shared/domain";
import { actIdentity, MAX_PERFORMERS } from "../../shared/act-identity";
import { CURATED_THEMES, type ThemeId } from "../../shared/themes";

interface ActDraft {
  performers: Performer[];
  groupName: string;
  performerDisplayMode: PerformerDisplayMode;
  schoolYear: string;
  actName: string;
  actType: string;
  publicDescription: string;
  internalNotes: string;
  actImageAssetId: string;
  showDescriptionToAudience: boolean;
  showImageToAudience: boolean;
  showFullMemberListToAudience: boolean;
  performanceVisualMode: PerformanceVisualMode;
  performanceAssetId: string;
  performanceFit: ActPresentation["performanceFit"];
  backingAudioAssetId: string;
  backingAudioStart: ActPresentation["backingAudioStart"];
  themeId: ThemeId | "";
  fontFamily: string;
}

const EMPTY_ACT: ActDraft = {
  performers: [{ id: `performer-${crypto.randomUUID()}`, name: "" }],
  groupName: "",
  performerDisplayMode: "AUTOMATIC",
  schoolYear: "",
  actName: "",
  actType: "",
  publicDescription: "",
  internalNotes: "",
  actImageAssetId: "",
  showDescriptionToAudience: false,
  showImageToAudience: false,
  showFullMemberListToAudience: false,
  performanceVisualMode: "AUTOMATIC",
  performanceAssetId: "",
  performanceFit: "contain",
  backingAudioAssetId: "",
  backingAudioStart: "MANUAL",
  themeId: "",
  fontFamily: "",
};

type VisualChoice =
  "" | "TITLE_CARD" | "IMAGE" | "SLIDES" | "VIDEO" | "BLACK" | "CLEAR";
type AudioChoice =
  "" | "LOAD" | "PLAY" | "PAUSE" | "RESUME" | "STOP" | "REPLAY" | "SEEK";

interface CueDraft {
  operatorLabel: string;
  internalNote: string;
  visualKind: VisualChoice;
  visualAssetId: string;
  visualTitle: string;
  fit: "contain" | "cover";
  audioAction: AudioChoice;
  audioAssetId: string;
  seekSeconds: string;
}

const EMPTY_CUE: CueDraft = {
  operatorLabel: "",
  internalNote: "",
  visualKind: "",
  visualAssetId: "",
  visualTitle: "",
  fit: "contain",
  audioAction: "",
  audioAssetId: "",
  seekSeconds: "0",
};

/** Every media type the library accepts, in one place. */
const LIBRARY_ACCEPT =
  "image/jpeg,image/png,image/webp,audio/mpeg,audio/mp4,audio/ogg,audio/wav,video/mp4,video/webm";

type LibraryKind = MediaAsset["kind"];

/**
 * A file chosen before the act exists. It waits in the browser, can already be
 * assigned to a presentation slot, and is uploaded into the act's library the
 * moment the act has been created. Its id is local and never reaches the
 * server: slots that point at a queued file are resolved to real asset ids
 * after the upload.
 */
interface QueuedFile {
  id: string;
  file: File;
  kind: LibraryKind;
  /** Object URL for the local preview; revoked when the entry goes. */
  url: string;
  /** Set when an upload attempt failed; the entry stays so it can be retried. */
  error: string | null;
}

/** One selectable entry for the presentation slots, from either source. */
interface MediaChoice {
  id: string;
  label: string;
  description: string;
  url: string;
  kind: LibraryKind;
}

type UploadOutcome =
  { ok: true; assetId: string } | { ok: false; error: string };

const QUEUED_PREFIX = "queued-";
const isQueuedId = (id: string) => id.startsWith(QUEUED_PREFIX);

function libraryKind(file: File): LibraryKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

function describeFile(file: File): string {
  return `${(file.size / 1_048_576).toFixed(1)} MB`;
}

function actDraft(act: AdminAct | null): ActDraft {
  return act
    ? {
        performers:
          act.performers && act.performers.length > 0
            ? [...act.performers]
            : [
                {
                  id: `performer-${crypto.randomUUID()}`,
                  name: act.performerName,
                },
              ],
        groupName: act.groupName ?? "",
        performerDisplayMode: act.performerDisplayMode ?? "AUTOMATIC",
        schoolYear: act.schoolYear,
        actName: act.actName,
        actType: act.actType,
        publicDescription: act.publicDescription,
        internalNotes: act.internalNotes,
        actImageAssetId:
          act.presentation.actImageAssetId ?? act.publicImageAssetId ?? "",
        showDescriptionToAudience: act.showDescriptionToAudience,
        showImageToAudience: act.showImageToAudience,
        showFullMemberListToAudience: act.showFullMemberListToAudience ?? false,
        performanceVisualMode: act.presentation.performanceVisualMode,
        performanceAssetId: act.presentation.performanceAssetId ?? "",
        performanceFit: act.presentation.performanceFit,
        backingAudioAssetId: act.presentation.backingAudioAssetId ?? "",
        backingAudioStart: act.presentation.backingAudioStart,
        themeId: act.appearance.themeId ?? "",
        fontFamily: act.appearance.fontFamily ?? "",
      }
    : { ...EMPTY_ACT };
}

function describeAsset(asset: MediaAsset): string {
  const size = `${(asset.sizeBytes / 1_048_576).toFixed(1)} MB`;
  const duration =
    asset.durationMs === null
      ? null
      : `${Math.floor(asset.durationMs / 60_000)}:${String(
          Math.round((asset.durationMs % 60_000) / 1000),
        ).padStart(2, "0")}`;
  const dimensions =
    asset.width && asset.height ? `${asset.width}×${asset.height}` : null;
  return [asset.kind, duration, dimensions, size].filter(Boolean).join(" · ");
}

/** A reference in the words the operator used to create it. */
function referenceLabel(reference: MediaAssetReference): string {
  switch (reference.kind) {
    case "act_image":
      return "ACT IMAGE";
    case "backing_audio":
      return "BACKING AUDIO";
    case "performance_visual":
      return "PERFORMANCE VISUAL";
    case "cue":
      return "CUE";
  }
}

function cueDraft(cue: PersistedCue | null): CueDraft {
  if (!cue) return { ...EMPTY_CUE };
  const visual = cue.operations.find(
    (operation): operation is Extract<CueOperation, { kind: "visual" }> =>
      operation.kind === "visual",
  );
  const audio = cue.operations.find(
    (operation): operation is Extract<CueOperation, { kind: "audio" }> =>
      operation.kind === "audio",
  );
  return {
    operatorLabel: cue.operatorLabel,
    internalNote: cue.internalNote,
    visualKind: visual?.visual.kind ?? "",
    visualAssetId: visual?.visual.sourceKey ?? "",
    visualTitle: visual?.visual.title ?? "",
    fit: visual?.visual.fit ?? "contain",
    audioAction: audio?.action ?? "",
    audioAssetId: audio?.assetId ?? "",
    seekSeconds:
      audio?.positionMs === undefined ? "0" : String(audio.positionMs / 1_000),
  };
}

async function readError(response: Response): Promise<string> {
  const result = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return result?.error ?? `Request failed (HTTP ${response.status})`;
}

function assetUrl(asset: MediaAsset): string {
  return `/api/admin/media/${encodeURIComponent(asset.id)}?v=${encodeURIComponent(asset.versionIdentifier)}`;
}

function move<Item>(items: readonly Item[], from: number, to: number): Item[] {
  const result = [...items];
  const [item] = result.splice(from, 1);
  if (item !== undefined) result.splice(to, 0, item);
  return result;
}

function inspectMedia(file: File): Promise<{
  durationMs: number | null;
  width: number | null;
  height: number | null;
}> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const finish = (result: {
      durationMs: number | null;
      width: number | null;
      height: number | null;
    }) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    if (file.type.startsWith("image/")) {
      const image = new Image();
      image.onload = () =>
        finish({
          durationMs: null,
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      image.onerror = () =>
        finish({ durationMs: null, width: null, height: null });
      image.src = url;
      return;
    }
    const media = document.createElement(
      file.type.startsWith("video/") ? "video" : "audio",
    );
    media.preload = "metadata";
    media.onloadedmetadata = () =>
      finish({
        durationMs: Number.isFinite(media.duration)
          ? Math.round(media.duration * 1_000)
          : null,
        width: media instanceof HTMLVideoElement ? media.videoWidth : null,
        height: media instanceof HTMLVideoElement ? media.videoHeight : null,
      });
    media.onerror = () =>
      finish({ durationMs: null, width: null, height: null });
    media.src = url;
  });
}

export interface ActEditorProps {
  acts: readonly AdminAct[];
  activeActId: string | null;
  onSelectLive: (actId: string) => void;
}

export function ActEditor({ acts, activeActId, onSelectLive }: ActEditorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    activeActId ?? acts[0]?.id ?? null,
  );
  const selected = acts.find((act) => act.id === selectedId) ?? null;
  const [creating, setCreating] = useState(acts.length === 0);
  const [draft, setDraft] = useState<ActDraft>(() => actDraft(selected));
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [cachedFonts, setCachedFonts] = useState<string[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [imageSequence, setImageSequence] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState<Record<string, number>>({});
  const [dragging, setDragging] = useState(false);
  const [queued, setQueued] = useState<QueuedFile[]>([]);
  // Files that failed during creation stay queued for a retry; the switch from
  // "creating" to the new act must not wipe them.
  const keepQueueRef = useRef(false);
  const actsRef = useRef(acts);
  actsRef.current = acts;
  const [cueId, setCueId] = useState<string | null>(null);
  const currentCue = selected?.cues.find((cue) => cue.id === cueId) ?? null;
  const [cue, setCue] = useState<CueDraft>(() => cueDraft(currentCue));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<ActDeletionPreview | null>(null);
  const [deletePhrase, setDeletePhrase] = useState("");

  // Fall back to a real act only when the selection has gone stale (deleted,
  // or never made). An explicit "+ ADD ACT" clears the selection on purpose
  // and must not be undone here, or the new-act form could never open while
  // the running order has acts in it.
  useEffect(() => {
    if (creating) return;
    if (selectedId && acts.some((act) => act.id === selectedId)) return;
    const next = activeActId ?? acts[0]?.id ?? null;
    setSelectedId(next);
    setCreating(acts.length === 0);
  }, [acts, activeActId, selectedId, creating]);

  useEffect(() => {
    setDraft(actDraft(creating ? null : selected));
    setCueId(null);
    setCue({ ...EMPTY_CUE });
    setSelectedAssetId(null);
    setImageSequence(new Set());
    if (keepQueueRef.current) {
      keepQueueRef.current = false;
    } else {
      setQueued((current) => {
        current.forEach((entry) => URL.revokeObjectURL(entry.url));
        return [];
      });
    }
  }, [selectedId, creating]);

  // Nothing leaks when the editor unmounts mid-creation.
  useEffect(
    () => () => {
      setQueued((current) => {
        current.forEach((entry) => URL.revokeObjectURL(entry.url));
        return [];
      });
    },
    [],
  );

  useEffect(() => {
    setCue(cueDraft(currentCue));
  }, [currentCue]);

  /**
   * The library is the act's own: what it owns plus what it references. The
   * server decides membership from ownership and references, never from a
   * filename, and the list is re-read whenever the act's references change.
   */
  const libraryActId = creating ? null : (selected?.id ?? null);
  const referenceKey = selected
    ? [
        selected.presentation.actImageAssetId,
        selected.presentation.performanceAssetId,
        selected.presentation.backingAudioAssetId,
        ...selected.cues.map((entry) => entry.id),
      ].join("|")
    : "";
  useEffect(() => {
    let cancelled = false;
    if (!libraryActId) {
      setAssets([]);
      return;
    }
    void fetch(`/api/admin/media?actId=${encodeURIComponent(libraryActId)}`, {
      credentials: "same-origin",
    })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { assets: MediaAsset[] }).assets
          : [],
      )
      .then((list) => {
        if (!cancelled) setAssets(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [libraryActId, referenceKey]);

  async function refreshAssets(
    actId: string | null = libraryActId,
  ): Promise<void> {
    if (!actId) return;
    const response = await fetch(
      `/api/admin/media?actId=${encodeURIComponent(actId)}`,
      { credentials: "same-origin" },
    );
    if (response.ok) {
      const result = (await response.json()) as { assets: MediaAsset[] };
      setAssets(result.assets);
    }
  }

  useEffect(() => {
    void fetch("/api/admin/fonts/cached", { credentials: "same-origin" })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { families: string[] }).families
          : [],
      )
      .then(setCachedFonts)
      .catch(() => undefined);
  }, []);

  const images = useMemo(
    () => assets.filter((asset) => asset.kind === "image"),
    [assets],
  );
  const videos = useMemo(
    () => assets.filter((asset) => asset.kind === "video"),
    [assets],
  );
  const audioAssets = useMemo(
    () =>
      assets.filter(
        (asset) => asset.kind === "audio" || asset.kind === "video",
      ),
    [assets],
  );
  /**
   * What the presentation slots can point at. While the act is being created
   * the choices are the queued files; afterwards they are the act's library.
   * Either way the slot holds an id and the operator sees a filename.
   */
  const choices: MediaChoice[] = useMemo(
    () =>
      creating
        ? queued.map((entry) => ({
            id: entry.id,
            label: entry.file.name,
            description: describeFile(entry.file),
            url: entry.url,
            kind: entry.kind,
          }))
        : assets.map((asset) => ({
            id: asset.id,
            label: asset.originalFilename,
            description: describeAsset(asset),
            url: assetUrl(asset),
            kind: asset.kind,
          })),
    [creating, queued, assets],
  );
  const imageChoices = choices.filter((choice) => choice.kind === "image");
  const videoChoices = choices.filter((choice) => choice.kind === "video");
  const audioChoices = choices.filter(
    (choice) => choice.kind === "audio" || choice.kind === "video",
  );
  const preview = assets.find((asset) => asset.id === selectedAssetId) ?? null;
  const previewQueued =
    queued.find((entry) => entry.id === selectedAssetId) ?? null;
  const backingChoice =
    choices.find((choice) => choice.id === draft.backingAudioAssetId) ?? null;

  /** The slots a queued file has already been given, for its badges. */
  function queuedUses(id: string): string[] {
    const uses: string[] = [];
    if (draft.actImageAssetId === id) uses.push("ACT IMAGE");
    if (draft.performanceAssetId === id) uses.push("PERFORMANCE VISUAL");
    if (draft.backingAudioAssetId === id) uses.push("BACKING AUDIO");
    return uses;
  }

  function addFiles(files: readonly File[]): void {
    if (creating) {
      const accepted: QueuedFile[] = [];
      const refused: string[] = [];
      for (const file of files) {
        const kind = libraryKind(file);
        if (!kind) {
          refused.push(file.name);
          continue;
        }
        accepted.push({
          id: `${QUEUED_PREFIX}${crypto.randomUUID()}`,
          file,
          kind,
          url: URL.createObjectURL(file),
          error: null,
        });
      }
      if (accepted.length > 0)
        setQueued((current) => [...current, ...accepted]);
      setNotice(
        refused.length > 0
          ? `Not added (unsupported type): ${refused.join(", ")}.`
          : accepted.length > 0
            ? `${accepted.length} file${accepted.length === 1 ? "" : "s"} ready. ${accepted.length === 1 ? "It uploads" : "They upload"} into the act's library when you add the act.`
            : null,
      );
      return;
    }
    uploadFiles(files);
  }

  function removeQueued(id: string): void {
    setQueued((current) => {
      const entry = current.find((candidate) => candidate.id === id);
      if (entry) URL.revokeObjectURL(entry.url);
      return current.filter((candidate) => candidate.id !== id);
    });
    setSelectedAssetId((current) => (current === id ? null : current));
    // A slot cannot point at a file that is no longer coming.
    setDraft((current) => ({
      ...current,
      actImageAssetId:
        current.actImageAssetId === id ? "" : current.actImageAssetId,
      performanceAssetId:
        current.performanceAssetId === id ? "" : current.performanceAssetId,
      performanceVisualMode:
        current.performanceAssetId === id
          ? "AUTOMATIC"
          : current.performanceVisualMode,
      backingAudioAssetId:
        current.backingAudioAssetId === id ? "" : current.backingAudioAssetId,
    }));
  }

  /** A file that failed during creation is uploaded into the existing act. */
  async function retryQueued(entry: QueuedFile): Promise<void> {
    if (!libraryActId) return;
    setBusy(true);
    const outcome = await uploadFile(entry.file, libraryActId);
    setBusy(false);
    if (outcome.ok) {
      removeQueued(entry.id);
      setNotice(
        `${entry.file.name} is in the act's library. Choose it in a Presentation slot if it was meant for one.`,
      );
    } else {
      setQueued((current) =>
        current.map((candidate) =>
          candidate.id === entry.id
            ? { ...candidate, error: outcome.error }
            : candidate,
        ),
      );
      setNotice(`${entry.file.name} failed again: ${outcome.error}.`);
    }
  }

  function updateAct<Field extends keyof ActDraft>(
    field: Field,
    value: ActDraft[Field],
  ) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  /** The request body for POST and PATCH, from a draft. */
  function actBody(source: ActDraft): string {
    return JSON.stringify({
      performers: source.performers,
      groupName: source.groupName,
      performerDisplayMode: source.performerDisplayMode,
      schoolYear: source.schoolYear,
      actName: source.actName,
      actType: source.actType,
      publicDescription: source.publicDescription,
      internalNotes: source.internalNotes,
      publicImageAssetId: source.actImageAssetId || null,
      showDescriptionToAudience: source.showDescriptionToAudience,
      showImageToAudience: source.showImageToAudience,
      showFullMemberListToAudience: source.showFullMemberListToAudience,
      presentation: {
        actImageAssetId: source.actImageAssetId || null,
        performanceVisualMode: source.performanceVisualMode,
        performanceAssetId:
          source.performanceVisualMode === "AUTOMATIC"
            ? null
            : source.performanceAssetId || null,
        performanceFit: source.performanceFit,
        backingAudioAssetId: source.backingAudioAssetId || null,
        backingAudioStart: source.backingAudioStart,
      },
      appearance: {
        themeId: source.themeId || null,
        fontFamily: source.fontFamily || null,
      },
    });
  }

  async function saveAct(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (creating) {
      await createActWithMedia();
      return;
    }
    setBusy(true);
    setNotice(null);
    const response = await fetch(
      `/api/admin/acts/${encodeURIComponent(selected?.id ?? "")}`,
      {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: actBody(draft),
      },
    );
    const result = (await response.json().catch(() => null)) as {
      act?: AdminAct;
      error?: string;
    } | null;
    setBusy(false);
    setNotice(
      response.ok ? "Act saved." : (result?.error ?? "Act could not be saved."),
    );
  }

  /**
   * One creation, from the operator's point of view. The act is created
   * first (its slots temporarily empty where they point at files that do not
   * exist yet), the queued files are uploaded into the new act's library one
   * after another, and the slots are then assigned their real asset ids. A
   * file that fails stays in the queue, named, with a retry; the act itself
   * is never left half-made or unexplained.
   */
  async function createActWithMedia(): Promise<void> {
    setBusy(true);
    setNotice(null);
    const withoutQueued: ActDraft = {
      ...draft,
      actImageAssetId: isQueuedId(draft.actImageAssetId)
        ? ""
        : draft.actImageAssetId,
      performanceAssetId: isQueuedId(draft.performanceAssetId)
        ? ""
        : draft.performanceAssetId,
      performanceVisualMode: isQueuedId(draft.performanceAssetId)
        ? "AUTOMATIC"
        : draft.performanceVisualMode,
      backingAudioAssetId: isQueuedId(draft.backingAudioAssetId)
        ? ""
        : draft.backingAudioAssetId,
    };
    const response = await fetch("/api/admin/acts", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: actBody(withoutQueued),
    });
    const result = (await response.json().catch(() => null)) as {
      act?: AdminAct;
      error?: string;
    } | null;
    if (!response.ok || !result?.act) {
      setBusy(false);
      setNotice(result?.error ?? "Act could not be created.");
      return;
    }
    const actId = result.act.id;

    const uploaded = new Map<string, string>();
    const failed: QueuedFile[] = [];
    for (const [index, entry] of queued.entries()) {
      setNotice(
        `Act created. Uploading ${entry.file.name} (${index + 1} of ${queued.length})…`,
      );
      const outcome = await uploadFile(entry.file, actId);
      if (outcome.ok) {
        uploaded.set(entry.id, outcome.assetId);
        URL.revokeObjectURL(entry.url);
      } else {
        failed.push({ ...entry, error: outcome.error });
      }
    }

    const resolve = (id: string) =>
      isQueuedId(id) ? (uploaded.get(id) ?? "") : id;
    const assigned: ActDraft = {
      ...draft,
      actImageAssetId: resolve(draft.actImageAssetId),
      performanceAssetId: resolve(draft.performanceAssetId),
      backingAudioAssetId: resolve(draft.backingAudioAssetId),
    };
    if (
      assigned.performanceVisualMode !== "AUTOMATIC" &&
      !assigned.performanceAssetId
    )
      assigned.performanceVisualMode = "AUTOMATIC";
    const slotsToAssign =
      uploaded.size > 0 &&
      (assigned.actImageAssetId !== withoutQueued.actImageAssetId ||
        assigned.performanceAssetId !== withoutQueued.performanceAssetId ||
        assigned.backingAudioAssetId !== withoutQueued.backingAudioAssetId);
    let assignmentError: string | null = null;
    if (slotsToAssign) {
      const patch = await fetch(
        `/api/admin/acts/${encodeURIComponent(actId)}`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: actBody(assigned),
        },
      );
      if (!patch.ok) assignmentError = await readError(patch);
    }

    // Let the running order catch up before the editor switches to the new
    // act, so the form fills from the server's copy rather than an empty draft.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (actsRef.current.some((act) => act.id === actId)) break;
      await new Promise((tick) => setTimeout(tick, 100));
    }
    keepQueueRef.current = failed.length > 0;
    setQueued(failed);
    setSelectedId(actId);
    setCreating(false);
    setBusy(false);

    const parts: string[] = ["Act added to the running order."];
    if (uploaded.size > 0)
      parts.push(
        `${uploaded.size} file${uploaded.size === 1 ? "" : "s"} uploaded to its media library.`,
      );
    if (assignmentError)
      parts.push(
        `The files are in the library, but assigning them to the slots failed: ${assignmentError}. Choose them in Presentation and save.`,
      );
    if (failed.length > 0)
      parts.push(
        `${failed.length} upload${failed.length === 1 ? "" : "s"} failed (${failed
          .map((entry) => `${entry.file.name}: ${entry.error}`)
          .join(
            "; ",
          )}). ${failed.length === 1 ? "It is" : "They are"} kept below for RETRY UPLOAD; any slot that was meant for ${failed.length === 1 ? "it" : "them"} is empty until then.`,
      );
    setNotice(parts.join(" "));
  }

  /**
   * Deleting is two steps on purpose. The first asks the server what would
   * actually be destroyed — scores, cues, files only this act uses — so the
   * operator confirms against the truth instead of a generic warning.
   */
  async function openDeletion(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    const response = await fetch(
      `/api/admin/acts/${encodeURIComponent(selected.id)}/deletion`,
      { credentials: "same-origin" },
    );
    setBusy(false);
    if (!response.ok) {
      setNotice(await readError(response));
      return;
    }
    setDeletePhrase("");
    setDeletion((await response.json()) as ActDeletionPreview);
  }

  async function duplicateSelected(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    const response = await fetch(
      `/api/admin/acts/${encodeURIComponent(selected.id)}/duplicate`,
      { method: "POST", credentials: "same-origin" },
    );
    const result = (await response.json().catch(() => null)) as {
      act?: AdminAct;
      error?: string;
    } | null;
    setBusy(false);
    if (!response.ok || !result?.act) {
      setNotice(result?.error ?? "Act could not be duplicated.");
      return;
    }
    setSelectedId(result.act.id);
    setCreating(false);
    setNotice("Act duplicated without votes, scores, results or manual cues.");
  }

  async function confirmDeletion(): Promise<void> {
    if (!deletion) return;
    setBusy(true);
    setNotice(null);
    const response = await fetch(
      `/api/admin/acts/${encodeURIComponent(deletion.actId)}`,
      {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE ACT" }),
      },
    );
    const result = (await response.json().catch(() => null)) as {
      error?: string;
      retiredAssets?: number;
      keptSharedAssets?: number;
      objectsDeleted?: number;
      objectsPending?: number;
      cleanupComplete?: boolean;
    } | null;
    setBusy(false);
    setDeletion(null);
    setDeletePhrase("");
    if (!response.ok) {
      setNotice(result?.error ?? "Act could not be deleted.");
      return;
    }
    setSelectedId(null);
    const kept = result?.keptSharedAssets
      ? ` ${result.keptSharedAssets} shared file(s) kept.`
      : "";
    setNotice(
      result?.cleanupComplete === false
        ? `Act deleted, but ${result.objectsPending} media file(s) could not be removed from storage yet. Retry from Setup → Danger.${kept}`
        : `Act deleted. ${result?.objectsDeleted ?? 0} media file(s) removed.${kept}`,
    );
  }

  async function reorderAct(direction: -1 | 1): Promise<void> {
    if (!selected) return;
    const from = acts.findIndex((act) => act.id === selected.id);
    const to = from + direction;
    if (to < 0 || to >= acts.length) return;
    const response = await fetch("/api/admin/acts/reorder", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: move(acts, from, to).map((act) => act.id) }),
    });
    setNotice(
      response.ok ? "Running order updated." : await readError(response),
    );
  }

  /**
   * One upload path for every kind of media. The file lands in the given
   * act's library, its metadata is read here in the browser and recorded, and
   * the returned asset ID is what every slot and cue then refers to.
   */
  function uploadFile(file: File, actId: string): Promise<UploadOutcome> {
    return new Promise<UploadOutcome>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        "POST",
        `/api/admin/media?filename=${encodeURIComponent(file.name)}&actId=${encodeURIComponent(actId)}`,
      );
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable)
          setUploading((current) => ({
            ...current,
            [file.name]: Math.round((event.loaded / event.total) * 100),
          }));
      };
      const finished = () =>
        setUploading((current) => {
          const next = { ...current };
          delete next[file.name];
          return next;
        });
      xhr.onload = () => {
        finished();
        if (xhr.status >= 200 && xhr.status < 300) {
          let assetId: string | null;
          try {
            const result = JSON.parse(xhr.responseText) as {
              asset?: { id?: unknown };
            };
            assetId =
              typeof result.asset?.id === "string" ? result.asset.id : null;
          } catch {
            assetId = null;
          }
          if (!assetId) {
            resolve({ ok: false, error: "the server returned no asset id" });
            return;
          }
          const id = assetId;
          void (async () => {
            const metadata = await inspectMedia(file);
            await fetch(`/api/admin/media/${encodeURIComponent(id)}/metadata`, {
              method: "PATCH",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(metadata),
            }).catch(() => undefined);
            await refreshAssets(actId).catch(() => undefined);
          })().finally(() => resolve({ ok: true, assetId: id }));
        } else {
          let detail = `HTTP ${xhr.status}`;
          try {
            const result = JSON.parse(xhr.responseText) as { error?: string };
            if (result.error) detail = result.error;
          } catch {
            // Keep the status code.
          }
          resolve({ ok: false, error: detail });
        }
      };
      xhr.onerror = () => {
        finished();
        resolve({ ok: false, error: "the upload could not reach the server" });
      };
      setUploading((current) => ({ ...current, [file.name]: 0 }));
      xhr.send(file);
    });
  }

  /** Uploads into the current act's library and reports each result. */
  function uploadFiles(files: readonly File[]): void {
    const actId = libraryActId;
    if (!actId) return;
    void Promise.all(
      files.map(async (file) => {
        const outcome = await uploadFile(file, actId);
        setNotice(
          outcome.ok
            ? `${file.name} added to the act's media library.`
            : `${file.name} failed: ${outcome.error}.`,
        );
      }),
    );
  }

  async function deleteAsset(asset: MediaAsset): Promise<void> {
    if (asset.referenced) {
      setNotice(
        "This file is in use. Remove it from the slots and cues that use it before deleting it.",
      );
      return;
    }
    if (!window.confirm(`Delete ${asset.originalFilename} from storage?`))
      return;
    const response = await fetch(
      `/api/admin/media/${encodeURIComponent(asset.id)}`,
      {
        method: "DELETE",
        credentials: "same-origin",
      },
    );
    setNotice(response.ok ? "Media deleted." : await readError(response));
    if (response.ok) {
      setSelectedAssetId((current) => (current === asset.id ? null : current));
      await refreshAssets();
    }
  }

  function cueOperations(): CueOperation[] | null {
    const operations: CueOperation[] = [];
    if (cue.visualKind) {
      const needsAsset = ["IMAGE", "SLIDES", "VIDEO"].includes(cue.visualKind);
      if (needsAsset && !cue.visualAssetId) return null;
      operations.push({
        kind: "visual",
        visual: {
          kind: cue.visualKind,
          sourceKey: needsAsset ? cue.visualAssetId : null,
          title: cue.visualKind === "TITLE_CARD" ? cue.visualTitle : null,
          ...(cue.visualKind === "IMAGE" && cue.fit === "cover"
            ? { fit: "cover" as const }
            : {}),
        },
      });
    }
    if (cue.audioAction) {
      if (cue.audioAction === "LOAD" && !cue.audioAssetId) return null;
      const positionMs = Math.round(Number(cue.seekSeconds) * 1_000);
      if (
        cue.audioAction === "SEEK" &&
        (!Number.isSafeInteger(positionMs) || positionMs < 0)
      )
        return null;
      operations.push({
        kind: "audio",
        action: cue.audioAction,
        ...((cue.audioAction === "LOAD" || cue.audioAction === "PLAY") &&
        cue.audioAssetId
          ? { assetId: cue.audioAssetId }
          : {}),
        ...(cue.audioAction === "SEEK" ? { positionMs } : {}),
      });
    }
    return operations.length ? operations : null;
  }

  async function saveCue(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected) return;
    const operations = cueOperations();
    if (!operations) {
      setNotice("Choose at least one complete visual or audio operation.");
      return;
    }
    const response = await fetch(
      currentCue
        ? `/api/admin/cues/${encodeURIComponent(currentCue.id)}`
        : "/api/admin/cues",
      {
        method: currentCue ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actId: selected.id,
          operatorLabel: cue.operatorLabel,
          internalNote: cue.internalNote,
          operations,
        }),
      },
    );
    const result = (await response.json().catch(() => null)) as {
      cueId?: string;
      error?: string;
    } | null;
    if (!response.ok) {
      setNotice(result?.error ?? "Cue could not be saved.");
      return;
    }
    if (result?.cueId) setCueId(result.cueId);
    setNotice(currentCue ? "Cue updated." : "Cue added.");
  }

  async function cueAction(
    action: "duplicate" | "delete",
    target: PersistedCue,
  ): Promise<void> {
    if (
      action === "delete" &&
      !window.confirm(`Delete cue “${target.operatorLabel}”?`)
    )
      return;
    const response = await fetch(
      `/api/admin/cues/${encodeURIComponent(target.id)}${action === "duplicate" ? "/duplicate" : ""}`,
      {
        method: action === "duplicate" ? "POST" : "DELETE",
        credentials: "same-origin",
      },
    );
    setNotice(
      response.ok
        ? `Cue ${action === "duplicate" ? "duplicated" : "deleted"}.`
        : await readError(response),
    );
    if (action === "delete" && response.ok) setCueId(null);
  }

  async function reorderCue(
    target: PersistedCue,
    direction: -1 | 1,
  ): Promise<void> {
    if (!selected) return;
    const from = selected.cues.findIndex((item) => item.id === target.id);
    const to = from + direction;
    if (to < 0 || to >= selected.cues.length) return;
    const response = await fetch("/api/admin/cues/reorder", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actId: selected.id,
        ids: move(selected.cues, from, to).map((item) => item.id),
      }),
    });
    setNotice(response.ok ? "Cue order updated." : await readError(response));
  }

  async function addImageSequence(): Promise<void> {
    if (!selected || imageSequence.size === 0) return;
    const ordered = images.filter((asset) => imageSequence.has(asset.id));
    setBusy(true);
    for (const asset of ordered) {
      const response = await fetch("/api/admin/cues", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actId: selected.id,
          operatorLabel: asset.originalFilename,
          internalNote: "",
          operations: [
            {
              kind: "visual",
              visual: {
                kind: "IMAGE",
                sourceKey: asset.id,
                title: null,
                fit: "contain",
              },
            },
          ],
        }),
      });
      if (!response.ok) {
        setNotice(
          `Stopped after ${asset.originalFilename}: ${await readError(response)}`,
        );
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    setImageSequence(new Set());
    setNotice(
      `${ordered.length} image cue${ordered.length === 1 ? "" : "s"} added in library order.`,
    );
  }

  const performanceChoices =
    draft.performanceVisualMode === "VIDEO" ? videoChoices : imageChoices;
  const fontChoices = [
    ...new Set([...cachedFonts, draft.fontFamily].filter(Boolean)),
  ].sort();

  return (
    <div className="act-editor">
      <header className="act-editor__head">
        <p>ACTS & MEDIA</p>
        <h2>Build the running order</h2>
        <span>
          Each act has one media library. Its image, backing audio, performance
          visual and any advanced cues all point at files in it. Files can be
          added while the act is being created.
        </span>
        <button
          type="button"
          onClick={() => {
            setCreating(true);
            setSelectedId(null);
          }}
        >
          + ADD ACT
        </button>
      </header>
      <aside className="editor-order" aria-label="Editable running order">
        {acts.length === 0 && (
          <div className="empty-state">
            <strong>No acts yet</strong>
            <span>Add the first act to start building the show.</span>
            <button type="button" onClick={() => setCreating(true)}>
              ADD FIRST ACT
            </button>
          </div>
        )}
        {acts.map((act) => (
          <button
            type="button"
            key={act.id}
            className={!creating && selectedId === act.id ? "is-active" : ""}
            onClick={() => {
              setCreating(false);
              setSelectedId(act.id);
            }}
          >
            <b>{String(act.order + 1).padStart(2, "0")}</b>
            <span>
              <strong>{act.actName}</strong>
              <small>{actIdentity(act, { surface: "admin" }).compact}</small>
            </span>
            {act.id === activeActId && <em>LIVE</em>}
          </button>
        ))}
      </aside>
      <div className="act-editor__body">
        {creating || selected ? (
          <>
            <section className="editor-section">
              <div className="editor-section__title">
                <h3>{creating ? "New act" : "Act details"}</h3>
                {selected && !creating && (
                  <div>
                    <button type="button" onClick={() => void reorderAct(-1)}>
                      MOVE UP
                    </button>
                    <button type="button" onClick={() => void reorderAct(1)}>
                      MOVE DOWN
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectLive(selected.id)}
                    >
                      SELECT FOR SHOW
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void duplicateSelected()}
                    >
                      DUPLICATE
                    </button>
                  </div>
                )}
              </div>
              <form
                className="act-form"
                onSubmit={(event) => void saveAct(event)}
              >
                <fieldset className="act-form__wide performer-editor">
                  <legend>Performers</legend>
                  <p>
                    Add every person in the act. A group name is optional, even
                    for large ensembles.
                  </p>
                  <ol className="performer-editor__list">
                    {draft.performers.map((performer, index) => (
                      <li key={performer.id}>
                        <span>{index + 1}</span>
                        <input
                          required
                          aria-label={`Performer ${index + 1} name`}
                          maxLength={160}
                          value={performer.name}
                          onChange={(event) => {
                            const name = event.target.value;
                            setDraft((current) => ({
                              ...current,
                              performers: current.performers.map((entry) =>
                                entry.id === performer.id
                                  ? { ...entry, name }
                                  : entry,
                              ),
                            }));
                          }}
                        />
                        <button
                          type="button"
                          disabled={draft.performers.length === 1}
                          aria-label={`Remove performer ${index + 1}`}
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              performers: current.performers.filter(
                                (entry) => entry.id !== performer.id,
                              ),
                            }))
                          }
                        >
                          REMOVE
                        </button>
                      </li>
                    ))}
                  </ol>
                  <button
                    type="button"
                    disabled={draft.performers.length >= MAX_PERFORMERS}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        performers: [
                          ...current.performers,
                          {
                            id: `performer-${crypto.randomUUID()}`,
                            name: "",
                          },
                        ],
                      }))
                    }
                  >
                    + ADD PERFORMER
                  </button>
                  <small>
                    {draft.performers.length} of {MAX_PERFORMERS} performers
                  </small>
                </fieldset>
                <label>
                  Group name <small>Optional</small>
                  <input
                    maxLength={160}
                    value={draft.groupName}
                    onChange={(event) =>
                      updateAct("groupName", event.target.value)
                    }
                    placeholder="e.g. The Jazz Collective"
                  />
                </label>
                <label>
                  School year
                  <input
                    required
                    maxLength={80}
                    value={draft.schoolYear}
                    onChange={(event) =>
                      updateAct("schoolYear", event.target.value)
                    }
                  />
                </label>
                <label>
                  Act name
                  <input
                    required
                    maxLength={160}
                    value={draft.actName}
                    onChange={(event) =>
                      updateAct("actName", event.target.value)
                    }
                  />
                </label>
                <label>
                  Act type
                  <input
                    required
                    maxLength={100}
                    value={draft.actType}
                    onChange={(event) =>
                      updateAct("actType", event.target.value)
                    }
                    placeholder="Dance, vocal, magic…"
                  />
                </label>
                <label className="act-form__wide">
                  Public description
                  <textarea
                    maxLength={2000}
                    value={draft.publicDescription}
                    onChange={(event) =>
                      updateAct("publicDescription", event.target.value)
                    }
                  />
                </label>
                <label className="act-form__wide internal-field">
                  Internal notes{" "}
                  <small>Operator only — never sent to public clients</small>
                  <textarea
                    maxLength={4000}
                    value={draft.internalNotes}
                    onChange={(event) =>
                      updateAct("internalNotes", event.target.value)
                    }
                  />
                </label>

                <details className="act-form__wide display-options">
                  <summary>Advanced act display</summary>
                  <label>
                    Projector performer display
                    <select
                      value={draft.performerDisplayMode}
                      onChange={(event) =>
                        updateAct(
                          "performerDisplayMode",
                          event.target.value as PerformerDisplayMode,
                        )
                      }
                    >
                      <option value="AUTOMATIC">Automatic</option>
                      <option value="GROUP_NAME_ONLY">Group name only</option>
                      <option value="GROUP_NAME_AND_MEMBERS">
                        Group name + member names
                      </option>
                      <option value="MEMBER_NAMES">Member names</option>
                      <option value="PERFORMER_COUNT">Performer count</option>
                    </select>
                  </label>
                  <div className="identity-preview" aria-live="polite">
                    <small>PROJECTOR PREVIEW</small>
                    <b>
                      {
                        actIdentity(
                          {
                            performerName:
                              draft.performers[0]?.name || "Performer",
                            performers: draft.performers,
                            performerCount: draft.performers.length,
                            groupName: draft.groupName,
                            performerDisplayMode: draft.performerDisplayMode,
                          },
                          { surface: "projector" },
                        ).primary
                      }
                    </b>
                    <span>
                      {
                        actIdentity(
                          {
                            performerName:
                              draft.performers[0]?.name || "Performer",
                            performers: draft.performers,
                            performerCount: draft.performers.length,
                            groupName: draft.groupName,
                            performerDisplayMode: draft.performerDisplayMode,
                          },
                          { surface: "projector" },
                        ).secondary
                      }
                    </span>
                  </div>
                </details>

                {/*
                  The one library. Every file for this act arrives here, once,
                  and is then chosen by name in the slots below. While the act
                  is still being created the files wait in a local queue and
                  are uploaded the moment the act exists, so creating an act
                  with its media is one step. There are no separate uploaders
                  for image, audio or performance media.
                */}
                <fieldset className="act-form__wide media-library">
                  <legend>Act media library</legend>
                  <label
                    className={`drop-zone__target${dragging ? " is-dragging" : ""}`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      addFiles([...event.dataTransfer.files]);
                    }}
                  >
                    <span>
                      {dragging
                        ? "Release to add to this act's library"
                        : creating
                          ? "Drop images, audio or video here, or click to choose files. They upload into this act's library when you add the act."
                          : "Drop images, audio or video here, or click to choose files"}
                    </span>
                    <input
                      type="file"
                      multiple
                      accept={LIBRARY_ACCEPT}
                      disabled={busy}
                      onChange={(event) => {
                        addFiles([...(event.target.files ?? [])]);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {Object.entries(uploading).map(([name, percent]) => (
                    <p className="upload-progress" key={name}>
                      <span>{name}</span>
                      <progress value={percent} max={100} /> {percent}%
                    </p>
                  ))}
                  {queued.length > 0 && (
                    <ul
                      className="media-list media-list--queued"
                      aria-label={
                        creating
                          ? "Files waiting to upload with the act"
                          : "Files that still need uploading"
                      }
                    >
                      {queued.map((entry) => (
                        <li
                          key={entry.id}
                          className={`media-list__item media-list__item--${entry.kind}${selectedAssetId === entry.id ? " is-active" : ""}`}
                        >
                          <button
                            type="button"
                            className="media-list__main"
                            onClick={() =>
                              setSelectedAssetId((current) =>
                                current === entry.id ? null : entry.id,
                              )
                            }
                          >
                            <em className="media-list__kind">
                              {entry.kind.toUpperCase()}
                            </em>
                            <b>{entry.file.name}</b>
                            <small>{describeFile(entry.file)}</small>
                          </button>
                          <span className="media-list__flags">
                            <em className="media-list__state">
                              {entry.error
                                ? "UPLOAD FAILED"
                                : creating
                                  ? "UPLOADS WITH THE ACT"
                                  : "NOT UPLOADED"}
                            </em>
                            {queuedUses(entry.id).map((use) => (
                              <em key={use} className="media-list__use">
                                {use}
                              </em>
                            ))}
                          </span>
                          <span className="media-list__actions">
                            {!creating && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void retryQueued(entry)}
                              >
                                RETRY UPLOAD
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => removeQueued(entry.id)}
                            >
                              REMOVE
                            </button>
                          </span>
                          {entry.error && (
                            <small className="media-list__error">
                              {entry.error}
                            </small>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {creating && queued.length === 0 && (
                    <p className="media-library__empty">
                      No media yet. Add files now and they upload with the act,
                      or add them any time later. Without any, the act still has
                      a finished performance screen drawn from its name.
                    </p>
                  )}
                  {!creating && assets.length === 0 && queued.length === 0 && (
                    <p className="media-library__empty">
                      No media yet. Without any, the act still has a finished
                      performance screen drawn from its name.
                    </p>
                  )}
                  {!creating && (
                    <ul className="media-list">
                      {assets.map((asset) => {
                        const mine = asset.references.filter(
                          (reference) => reference.actId === selected?.id,
                        );
                        const shared =
                          asset.actId !== null && asset.actId !== selected?.id;
                        return (
                          <li
                            key={asset.id}
                            className={`media-list__item media-list__item--${asset.kind}${selectedAssetId === asset.id ? " is-active" : ""}`}
                          >
                            <button
                              type="button"
                              className="media-list__main"
                              onClick={() =>
                                setSelectedAssetId((current) =>
                                  current === asset.id ? null : asset.id,
                                )
                              }
                            >
                              <em className="media-list__kind">
                                {asset.kind.toUpperCase()}
                              </em>
                              <b>{asset.originalFilename}</b>
                              <small>{describeAsset(asset)}</small>
                            </button>
                            <span className="media-list__flags">
                              <em
                                className={`media-list__state${asset.readiness === "READY" ? " media-list__state--ready" : ""}`}
                              >
                                {asset.readiness}
                              </em>
                              {asset.generatedTest && (
                                <em className="media-list__state">TEST</em>
                              )}
                              {shared && (
                                <em className="media-list__state">SHARED</em>
                              )}
                              {asset.actId === null && (
                                <em className="media-list__state">SHOW FILE</em>
                              )}
                              {mine.map((reference, index) => (
                                <em
                                  key={`${reference.kind}-${index}`}
                                  className="media-list__use"
                                >
                                  {referenceLabel(reference)}
                                </em>
                              ))}
                              {asset.references.length > mine.length && (
                                <em className="media-list__use">
                                  USED BY ANOTHER ACT
                                </em>
                              )}
                            </span>
                            <span className="media-list__actions">
                              {asset.kind === "image" && (
                                <label className="media-list__sequence">
                                  <input
                                    type="checkbox"
                                    checked={imageSequence.has(asset.id)}
                                    onChange={(event) =>
                                      setImageSequence((current) => {
                                        const next = new Set(current);
                                        if (event.target.checked)
                                          next.add(asset.id);
                                        else next.delete(asset.id);
                                        return next;
                                      })
                                    }
                                  />
                                  sequence
                                </label>
                              )}
                              <button
                                type="button"
                                disabled={asset.referenced}
                                title={
                                  asset.referenced
                                    ? "In use; remove it from the slots and cues first"
                                    : "Delete from storage"
                                }
                                onClick={() => void deleteAsset(asset)}
                              >
                                DELETE
                              </button>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {(preview || previewQueued) && (
                    <div className="media-preview">
                      <strong>
                        PREVIEW ·{" "}
                        {preview?.originalFilename ?? previewQueued?.file.name}
                      </strong>
                      {(() => {
                        const kind = preview?.kind ?? previewQueued?.kind;
                        const url = preview
                          ? assetUrl(preview)
                          : (previewQueued?.url ?? "");
                        return kind === "image" ? (
                          <img src={url} alt="" />
                        ) : kind === "video" ? (
                          <video src={url} controls />
                        ) : (
                          <audio src={url} controls />
                        );
                      })()}
                    </div>
                  )}
                </fieldset>

                <fieldset className="act-form__wide performance-fields">
                  <legend>Presentation</legend>
                  <p>
                    Every act already has a finished performance screen: its
                    name, performer/group identity and year, centred on the
                    projector. These slots choose files from the library above
                    {creating
                      ? ", including files still waiting to upload"
                      : ""}
                    ; the media cue for the performance is built from them
                    automatically.
                  </p>
                  <label>
                    Act image
                    <select
                      value={draft.actImageAssetId}
                      onChange={(event) =>
                        updateAct("actImageAssetId", event.target.value)
                      }
                    >
                      <option value="">None</option>
                      {imageChoices.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Performance visual
                    <select
                      value={draft.performanceVisualMode}
                      onChange={(event) => {
                        const mode = event.target
                          .value as PerformanceVisualMode;
                        setDraft((current) => ({
                          ...current,
                          performanceVisualMode: mode,
                          performanceAssetId:
                            mode === "AUTOMATIC"
                              ? ""
                              : current.performanceAssetId,
                        }));
                      }}
                    >
                      <option value="AUTOMATIC">
                        Automatic — drawn from the act
                      </option>
                      <option
                        value="IMAGE"
                        disabled={imageChoices.length === 0}
                      >
                        An image from the library
                      </option>
                      <option
                        value="VIDEO"
                        disabled={videoChoices.length === 0}
                      >
                        A video from the library
                      </option>
                    </select>
                  </label>
                  {draft.performanceVisualMode !== "AUTOMATIC" && (
                    <>
                      <label>
                        {draft.performanceVisualMode === "VIDEO"
                          ? "Performance video"
                          : "Performance image"}
                        <select
                          required
                          value={draft.performanceAssetId}
                          onChange={(event) =>
                            updateAct("performanceAssetId", event.target.value)
                          }
                        >
                          <option value="">Choose from the library</option>
                          {performanceChoices.map((choice) => (
                            <option key={choice.id} value={choice.id}>
                              {choice.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {draft.performanceVisualMode === "IMAGE" && (
                        <label>
                          Image framing
                          <select
                            value={draft.performanceFit}
                            onChange={(event) =>
                              updateAct(
                                "performanceFit",
                                event.target.value === "cover"
                                  ? "cover"
                                  : "contain",
                              )
                            }
                          >
                            <option value="contain">
                              Show the whole image (never cropped or stretched)
                            </option>
                            <option value="cover">
                              Crop to fill the screen
                            </option>
                          </select>
                        </label>
                      )}
                    </>
                  )}
                  {/*
                    Backing audio is an assignment, not an upload: the file is
                    in the library (or the creation queue) and this chooses
                    which one carries the role.
                  */}
                  <div className="backing-audio act-form__wide">
                    <strong>BACKING AUDIO</strong>
                    <label>
                      Backing audio track
                      <select
                        value={draft.backingAudioAssetId}
                        onChange={(event) =>
                          updateAct("backingAudioAssetId", event.target.value)
                        }
                      >
                        <option value="">None</option>
                        {audioChoices.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {audioChoices.length === 0 && (
                      <small className="backing-audio__hint">
                        Add an audio (or video) file to the library above to
                        choose it here.
                      </small>
                    )}
                    {backingChoice && (
                      <div className="backing-audio__selected">
                        <span>
                          <b>{backingChoice.label}</b>
                          <small>{backingChoice.description}</small>
                        </span>
                        <audio src={backingChoice.url} controls />
                        <button
                          type="button"
                          onClick={() => updateAct("backingAudioAssetId", "")}
                        >
                          REMOVE
                        </button>
                      </div>
                    )}
                  </div>
                  {draft.backingAudioAssetId && (
                    <label>
                      Start backing audio
                      <select
                        value={draft.backingAudioStart}
                        onChange={(event) =>
                          updateAct(
                            "backingAudioStart",
                            event.target.value === "PERFORMANCE"
                              ? "PERFORMANCE"
                              : "MANUAL",
                          )
                        }
                      >
                        <option value="PERFORMANCE">
                          Automatically, when PERFORMANCE begins
                        </option>
                        <option value="MANUAL">
                          Manually, when the operator presses GO on the cue
                        </option>
                      </select>
                    </label>
                  )}
                </fieldset>

                <details className="act-form__wide advanced-settings">
                  <summary>
                    Advanced settings
                    <small>
                      Appearance override, audience visibility. Rarely needed.
                    </small>
                  </summary>
                  <fieldset className="appearance-fields">
                    <legend>Appearance</legend>
                    <p>
                      The hall and the phones draw this act in these while it is
                      current. Curated themes and cached typefaces only, so
                      nothing can become unreadable.
                    </p>
                    <label>
                      Theme
                      <select
                        value={draft.themeId}
                        onChange={(event) =>
                          updateAct(
                            "themeId",
                            event.target.value as ThemeId | "",
                          )
                        }
                      >
                        <option value="">Inherit the show theme</option>
                        {CURATED_THEMES.map((theme) => (
                          <option key={theme.id} value={theme.id}>
                            {theme.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Typeface
                      <select
                        value={draft.fontFamily}
                        onChange={(event) =>
                          updateAct("fontFamily", event.target.value)
                        }
                      >
                        <option value="">Inherit the show typeface</option>
                        <option value="system-ui">System UI</option>
                        {fontChoices
                          .filter((family) => family !== "system-ui")
                          .map((family) => (
                            <option key={family} value={family}>
                              {family}
                            </option>
                          ))}
                      </select>
                    </label>
                  </fieldset>
                  <fieldset className="audience-fields">
                    <legend>On audience phones</legend>
                    <p>
                      Phones always receive the act name, public performer/group
                      identity and year or cohort. Optional detail is removed by
                      the server when its switch is off.
                    </p>
                    <label className="switch-row">
                      <input
                        type="checkbox"
                        checked={draft.showDescriptionToAudience}
                        onChange={(event) =>
                          updateAct(
                            "showDescriptionToAudience",
                            event.target.checked,
                          )
                        }
                      />
                      <span>Show description on audience phones</span>
                    </label>
                    <label className="switch-row">
                      <input
                        type="checkbox"
                        checked={draft.showImageToAudience}
                        onChange={(event) =>
                          updateAct("showImageToAudience", event.target.checked)
                        }
                      />
                      <span>Show act image on audience phones</span>
                    </label>
                    <label className="switch-row">
                      <input
                        type="checkbox"
                        checked={draft.showFullMemberListToAudience}
                        onChange={(event) =>
                          updateAct(
                            "showFullMemberListToAudience",
                            event.target.checked,
                          )
                        }
                      />
                      <span>Show full member list to audience</span>
                    </label>
                  </fieldset>
                </details>

                <div className="editor-actions act-form__wide">
                  <button type="submit" disabled={busy}>
                    {creating ? "ADD TO RUNNING ORDER" : "SAVE ACT"}
                  </button>
                  {!creating && (
                    <button
                      className="danger-action"
                      type="button"
                      disabled={busy}
                      onClick={() => void openDeletion()}
                    >
                      DELETE ACT
                    </button>
                  )}
                </div>
              </form>
            </section>

            {!creating && selected && (
              // The cue engine, in full, for acts that need hand-built
              // sequences. Every cue picks its media from the library above;
              // there is no second upload path here.
              <details className="advanced-cues">
                <summary>
                  Advanced cues
                  <small>
                    {selected.cues.length} cue
                    {selected.cues.length === 1 ? "" : "s"} · the derived
                    PERFORMANCE cue is managed for you · media comes from the
                    act's library
                  </small>
                </summary>
                <section className="editor-section cue-editor">
                  <div className="editor-section__title">
                    <h3>Cue stack</h3>
                    <div>
                      {imageSequence.size > 0 && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void addImageSequence()}
                        >
                          ADD {imageSequence.size} IMAGE
                          {imageSequence.size === 1 ? "" : "S"} AS SEQUENTIAL
                          CUES
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setCueId(null);
                          setCue({ ...EMPTY_CUE });
                        }}
                      >
                        + NEW CUE
                      </button>
                    </div>
                  </div>
                  <ol className="cue-list">
                    {selected.cues.map((item) => (
                      <li
                        key={item.id}
                        className={cueId === item.id ? "is-active" : ""}
                      >
                        <button type="button" onClick={() => setCueId(item.id)}>
                          <b>
                            {item.operatorLabel}
                            {item.origin === "SIMPLE" && (
                              <em className="cue-list__derived">AUTO</em>
                            )}
                          </b>
                          <small>
                            {item.operations.map(describeOperation).join(" + ")}
                          </small>
                          <em>{item.validationState ?? "VALID"}</em>
                        </button>
                        <span>
                          <button
                            type="button"
                            onClick={() => void reorderCue(item, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => void reorderCue(item, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() => void cueAction("duplicate", item)}
                          >
                            DUP
                          </button>
                          <button
                            type="button"
                            disabled={item.origin === "SIMPLE"}
                            onClick={() => void cueAction("delete", item)}
                          >
                            DEL
                          </button>
                        </span>
                      </li>
                    ))}
                  </ol>
                  <form
                    className="cue-form"
                    onSubmit={(event) => void saveCue(event)}
                  >
                    <label>
                      Operator label
                      <input
                        required
                        maxLength={160}
                        value={cue.operatorLabel}
                        onChange={(event) =>
                          setCue((current) => ({
                            ...current,
                            operatorLabel: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      What the screen does
                      <select
                        value={cue.visualKind}
                        onChange={(event) =>
                          setCue((current) => ({
                            ...current,
                            visualKind: event.target.value as VisualChoice,
                          }))
                        }
                      >
                        <option value="">Leave the screen as it is</option>
                        <option value="TITLE_CARD">Show a title card</option>
                        <option value="IMAGE">Show image</option>
                        <option value="SLIDES">Show slide</option>
                        <option value="VIDEO">Play video</option>
                        <option value="BLACK">Black screen</option>
                        <option value="CLEAR">Clear the screen</option>
                      </select>
                    </label>
                    {cue.visualKind === "TITLE_CARD" && (
                      <label>
                        Card title
                        <input
                          value={cue.visualTitle}
                          onChange={(event) =>
                            setCue((current) => ({
                              ...current,
                              visualTitle: event.target.value,
                            }))
                          }
                        />
                      </label>
                    )}
                    {["IMAGE", "SLIDES", "VIDEO"].includes(cue.visualKind) && (
                      <label>
                        Visual media (from the library)
                        <select
                          required
                          value={cue.visualAssetId}
                          onChange={(event) =>
                            setCue((current) => ({
                              ...current,
                              visualAssetId: event.target.value,
                            }))
                          }
                        >
                          <option value="">Choose media</option>
                          {(cue.visualKind === "VIDEO" ? videos : images).map(
                            (asset) => (
                              <option key={asset.id} value={asset.id}>
                                {asset.originalFilename}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    )}
                    {cue.visualKind === "IMAGE" && (
                      <label>
                        Image fit
                        <select
                          value={cue.fit}
                          onChange={(event) =>
                            setCue((current) => ({
                              ...current,
                              fit: event.target.value as "contain" | "cover",
                            }))
                          }
                        >
                          <option value="contain">
                            Contain — show entire image
                          </option>
                          <option value="cover">Cover — crop to fill</option>
                        </select>
                      </label>
                    )}
                    <label>
                      What the sound does
                      <select
                        value={cue.audioAction}
                        onChange={(event) =>
                          setCue((current) => ({
                            ...current,
                            audioAction: event.target.value as AudioChoice,
                          }))
                        }
                      >
                        <option value="">Leave audio as it is</option>
                        <option value="LOAD">Start backing audio</option>
                        <option value="PLAY">Play current backing audio</option>
                        <option value="PAUSE">Pause audio</option>
                        <option value="RESUME">Resume audio</option>
                        <option value="STOP">Stop audio</option>
                        <option value="REPLAY">
                          Replay audio from the start
                        </option>
                        <option value="SEEK">Jump to a point and play</option>
                      </select>
                    </label>
                    {(cue.audioAction === "LOAD" ||
                      cue.audioAction === "PLAY") && (
                      <label>
                        Audio media (from the library)
                        <select
                          required={cue.audioAction === "LOAD"}
                          value={cue.audioAssetId}
                          onChange={(event) =>
                            setCue((current) => ({
                              ...current,
                              audioAssetId: event.target.value,
                            }))
                          }
                        >
                          <option value="">Current backing audio</option>
                          {audioAssets.map((asset) => (
                            <option key={asset.id} value={asset.id}>
                              {asset.originalFilename}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {cue.audioAction === "SEEK" && (
                      <label>
                        Seek position (seconds)
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          value={cue.seekSeconds}
                          onChange={(event) =>
                            setCue((current) => ({
                              ...current,
                              seekSeconds: event.target.value,
                            }))
                          }
                        />
                      </label>
                    )}
                    <label className="cue-form__wide internal-field">
                      Cue note <small>Operator only</small>
                      <textarea
                        maxLength={2000}
                        value={cue.internalNote}
                        onChange={(event) =>
                          setCue((current) => ({
                            ...current,
                            internalNote: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={currentCue?.origin === "SIMPLE"}
                    >
                      {currentCue ? "SAVE CUE" : "ADD CUE"}
                    </button>
                    {currentCue?.origin === "SIMPLE" && (
                      <p className="cue-form__derived">
                        This cue is derived from the act's Presentation settings
                        above. Change it there and it is rebuilt.
                      </p>
                    )}
                  </form>
                </section>
              </details>
            )}
          </>
        ) : (
          <div className="empty-state">
            <strong>Select an act</strong>
            <span>Choose an act from the running order or add a new one.</span>
          </div>
        )}
      </div>
      {deletion && (
        <div
          className="act-delete"
          role="alertdialog"
          aria-labelledby="act-delete-title"
        >
          <div className="act-delete__card">
            <h3 id="act-delete-title">
              Delete “{deletion.actName}” by {deletion.performerName}?
            </h3>
            {deletion.blockers.length > 0 ? (
              <>
                <p className="act-delete__blocked">
                  This act cannot be deleted right now:
                </p>
                <ul className="act-delete__list">
                  {deletion.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
                <div className="act-delete__actions">
                  <button type="button" onClick={() => setDeletion(null)}>
                    CLOSE
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>This permanently removes:</p>
                <ul className="act-delete__list">
                  <li>the act and its {deletion.cues} cue(s)</li>
                  {deletion.audienceVotes > 0 && (
                    <li>
                      <b>{deletion.audienceVotes}</b> audience vote(s)
                    </li>
                  )}
                  {deletion.judgeSubmissions > 0 && (
                    <li>
                      <b>{deletion.judgeSubmissions}</b> judge score(s)
                    </li>
                  )}
                  {deletion.finalisedResult && (
                    <li>
                      <b>its finalised result</b> — it will leave the rankings
                    </li>
                  )}
                  {deletion.releasedAssets.map((asset) => (
                    <li key={asset.id}>
                      {asset.filename} (deleted from storage)
                    </li>
                  ))}
                  {deletion.sharedAssets.map((asset) => (
                    <li key={asset.id} className="act-delete__kept">
                      {asset.filename} — kept, another act uses it
                    </li>
                  ))}
                </ul>
                {deletion.isCurrentAct && (
                  <p className="act-delete__blocked">
                    This is the current act. Deleting it clears the current
                    selection.
                  </p>
                )}
                <label htmlFor="act-delete-phrase">
                  Type <b>DELETE ACT</b> to confirm
                </label>
                <input
                  id="act-delete-phrase"
                  type="text"
                  autoComplete="off"
                  value={deletePhrase}
                  onChange={(event) => setDeletePhrase(event.target.value)}
                />
                <div className="act-delete__actions">
                  <button
                    type="button"
                    className="danger-action"
                    disabled={busy || deletePhrase.trim() !== "DELETE ACT"}
                    onClick={() => void confirmDeletion()}
                  >
                    {busy ? "DELETING…" : "DELETE ACT"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDeletion(null)}
                  >
                    CANCEL
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {notice && (
        <output className="editor-notice" role="status">
          {notice}
        </output>
      )}
    </div>
  );
}

/** Mirrors the coordinator's deletion preview; see `worker/acts.ts`. */
interface ActDeletionPreview {
  actId: string;
  actName: string;
  performerName: string;
  isCurrentAct: boolean;
  audienceVotes: number;
  judgeSubmissions: number;
  finalisedResult: boolean;
  cues: number;
  releasedAssets: readonly {
    id: string;
    filename: string;
    sizeBytes: number;
  }[];
  sharedAssets: readonly { id: string; filename: string }[];
  blockers: readonly string[];
}
