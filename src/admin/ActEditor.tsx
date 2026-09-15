import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  AdminAct,
  CueOperation,
  MediaAsset,
  PersistedCue,
} from "../../shared/domain";

interface ActDraft {
  performerName: string;
  schoolYear: string;
  actName: string;
  actType: string;
  publicDescription: string;
  internalNotes: string;
  publicImageAssetId: string;
}

const EMPTY_ACT: ActDraft = {
  performerName: "",
  schoolYear: "",
  actName: "",
  actType: "",
  publicDescription: "",
  internalNotes: "",
  publicImageAssetId: "",
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

function actDraft(act: AdminAct | null): ActDraft {
  return act
    ? {
        performerName: act.performerName,
        schoolYear: act.schoolYear,
        actName: act.actName,
        actType: act.actType,
        publicDescription: act.publicDescription,
        internalNotes: act.internalNotes,
        publicImageAssetId: act.publicImageAssetId ?? "",
      }
    : { ...EMPTY_ACT };
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
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [imageSequence, setImageSequence] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState<Record<string, number>>({});
  const [cueId, setCueId] = useState<string | null>(null);
  const currentCue = selected?.cues.find((cue) => cue.id === cueId) ?? null;
  const [cue, setCue] = useState<CueDraft>(() => cueDraft(currentCue));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId && acts.some((act) => act.id === selectedId)) return;
    const next = activeActId ?? acts[0]?.id ?? null;
    setSelectedId(next);
    setCreating(acts.length === 0);
  }, [acts, activeActId, selectedId]);

  useEffect(() => {
    setDraft(actDraft(creating ? null : selected));
    setCueId(null);
    setCue({ ...EMPTY_CUE });
  }, [selectedId, creating]);

  useEffect(() => {
    setCue(cueDraft(currentCue));
  }, [currentCue]);

  async function refreshAssets(): Promise<void> {
    const response = await fetch("/api/admin/media", {
      credentials: "same-origin",
    });
    if (response.ok) {
      const result = (await response.json()) as { assets: MediaAsset[] };
      setAssets(result.assets);
    }
  }
  useEffect(() => {
    void refreshAssets();
  }, []);

  const images = useMemo(
    () => assets.filter((asset) => asset.mimeType.startsWith("image/")),
    [assets],
  );
  const audioAssets = useMemo(
    () =>
      assets.filter(
        (asset) =>
          asset.mimeType.startsWith("audio/") ||
          asset.mimeType.startsWith("video/"),
      ),
    [assets],
  );
  const visualAssets = useMemo(
    () =>
      assets.filter(
        (asset) =>
          asset.mimeType.startsWith("image/") ||
          asset.mimeType.startsWith("video/"),
      ),
    [assets],
  );
  const preview = assets.find((asset) => asset.id === selectedAssetId) ?? null;

  function updateAct<Field extends keyof ActDraft>(
    field: Field,
    value: ActDraft[Field],
  ) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function saveAct(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const endpoint = creating
      ? "/api/admin/acts"
      : `/api/admin/acts/${encodeURIComponent(selected?.id ?? "")}`;
    const response = await fetch(endpoint, {
      method: creating ? "POST" : "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...draft,
        publicImageAssetId: draft.publicImageAssetId || null,
      }),
    });
    const result = (await response.json().catch(() => null)) as {
      act?: AdminAct;
      error?: string;
    } | null;
    setBusy(false);
    if (!response.ok) {
      setNotice(result?.error ?? "Act could not be saved.");
      return;
    }
    if (creating && result?.act) setSelectedId(result.act.id);
    setCreating(false);
    setNotice(creating ? "Act added to the running order." : "Act saved.");
  }

  async function deleteAct(): Promise<void> {
    if (
      !selected ||
      !window.confirm(`Delete ${selected.actName}? This cannot be undone.`)
    )
      return;
    setBusy(true);
    const response = await fetch(
      `/api/admin/acts/${encodeURIComponent(selected.id)}`,
      {
        method: "DELETE",
        credentials: "same-origin",
      },
    );
    setBusy(false);
    if (!response.ok) {
      setNotice(await readError(response));
      return;
    }
    setSelectedId(null);
    setNotice("Act deleted.");
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

  function uploadFile(file: File): Promise<void> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        "POST",
        `/api/admin/media?filename=${encodeURIComponent(file.name)}`,
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
      xhr.onload = () => {
        setUploading((current) => {
          const next = { ...current };
          delete next[file.name];
          return next;
        });
        if (xhr.status >= 200 && xhr.status < 300) {
          setNotice(`${file.name} uploaded.`);
          let assetId: string | null = null;
          try {
            const result = JSON.parse(xhr.responseText) as {
              asset?: { id?: unknown };
            };
            assetId =
              typeof result.asset?.id === "string" ? result.asset.id : null;
          } catch {
            assetId = null;
          }
          void (async () => {
            if (assetId) {
              const metadata = await inspectMedia(file);
              await fetch(
                `/api/admin/media/${encodeURIComponent(assetId)}/metadata`,
                {
                  method: "PATCH",
                  credentials: "same-origin",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(metadata),
                },
              );
            }
            await refreshAssets();
          })().finally(resolve);
        } else {
          setNotice(`${file.name} failed (HTTP ${xhr.status}).`);
          resolve();
        }
      };
      xhr.onerror = () => {
        setUploading((current) => {
          const next = { ...current };
          delete next[file.name];
          return next;
        });
        setNotice(`${file.name} could not be uploaded.`);
        resolve();
      };
      setUploading((current) => ({ ...current, [file.name]: 0 }));
      xhr.send(file);
    });
  }

  async function deleteAsset(asset: MediaAsset): Promise<void> {
    if (asset.referenced) {
      setNotice("Remove this asset from acts and cues before deleting it.");
      return;
    }
    if (!window.confirm(`Delete ${asset.originalFilename}?`)) return;
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

  return (
    <div className="act-editor">
      <header className="act-editor__head">
        <p>ACTS & CUES</p>
        <h2>Build the running order</h2>
        <span>
          Public copy, private notes and independently layered media cues.
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
              <small>{act.performerName}</small>
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
                  </div>
                )}
              </div>
              <form
                className="act-form"
                onSubmit={(event) => void saveAct(event)}
              >
                <label>
                  Performer name
                  <input
                    required
                    maxLength={160}
                    value={draft.performerName}
                    onChange={(event) =>
                      updateAct("performerName", event.target.value)
                    }
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
                <label className="act-form__wide">
                  Public image
                  <select
                    value={draft.publicImageAssetId}
                    onChange={(event) =>
                      updateAct("publicImageAssetId", event.target.value)
                    }
                  >
                    <option value="">None</option>
                    {images.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.originalFilename}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="editor-actions act-form__wide">
                  <button type="submit" disabled={busy}>
                    {creating ? "ADD TO RUNNING ORDER" : "SAVE ACT"}
                  </button>
                  {!creating && (
                    <button
                      className="danger-action"
                      type="button"
                      disabled={busy}
                      onClick={() => void deleteAct()}
                    >
                      DELETE ACT
                    </button>
                  )}
                </div>
              </form>
            </section>

            {!creating && selected && (
              <>
                <section className="editor-section media-library">
                  <div className="editor-section__title">
                    <h3>Media library</h3>
                    <label className="upload-control">
                      UPLOAD FILES
                      <input
                        type="file"
                        multiple
                        accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/mp4,audio/ogg,audio/wav,video/mp4,video/webm"
                        onChange={(event) => {
                          const files = [...(event.target.files ?? [])];
                          void Promise.all(files.map(uploadFile));
                          event.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  {Object.entries(uploading).map(([name, percent]) => (
                    <p className="upload-progress" key={name}>
                      <span>{name}</span>
                      <progress value={percent} max={100} /> {percent}%
                    </p>
                  ))}
                  <div className="media-grid">
                    {assets.map((asset) => (
                      <article
                        key={asset.id}
                        className={
                          selectedAssetId === asset.id ? "is-active" : ""
                        }
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedAssetId(asset.id)}
                        >
                          <b>{asset.originalFilename}</b>
                          <small>
                            {asset.mimeType.replace(
                              /^(image|audio|video)\//u,
                              "",
                            )}{" "}
                            · {(asset.sizeBytes / 1_048_576).toFixed(1)} MB
                            {asset.width && asset.height
                              ? ` · ${asset.width}×${asset.height}`
                              : ""}
                            {asset.durationMs
                              ? ` · ${(asset.durationMs / 1000).toFixed(1)}s`
                              : ""}
                          </small>
                          <span>{asset.referenced ? "IN USE" : "UNUSED"}</span>
                        </button>
                        <button
                          type="button"
                          disabled={asset.referenced}
                          onClick={() => void deleteAsset(asset)}
                        >
                          DELETE
                        </button>
                        {asset.mimeType.startsWith("image/") && (
                          <label>
                            <input
                              type="checkbox"
                              checked={imageSequence.has(asset.id)}
                              onChange={(event) =>
                                setImageSequence((current) => {
                                  const next = new Set(current);
                                  if (event.target.checked) next.add(asset.id);
                                  else next.delete(asset.id);
                                  return next;
                                })
                              }
                            />{" "}
                            sequence
                          </label>
                        )}
                      </article>
                    ))}
                  </div>
                  {preview && (
                    <div className="media-preview">
                      <strong>PREVIEW · {preview.originalFilename}</strong>
                      {preview.mimeType.startsWith("image/") ? (
                        <img src={assetUrl(preview)} alt="" />
                      ) : preview.mimeType.startsWith("video/") ? (
                        <video src={assetUrl(preview)} controls />
                      ) : (
                        <audio src={assetUrl(preview)} controls />
                      )}
                    </div>
                  )}
                  {imageSequence.size > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void addImageSequence()}
                    >
                      ADD {imageSequence.size} IMAGES AS SEQUENTIAL CUES
                    </button>
                  )}
                </section>

                <section className="editor-section cue-editor">
                  <div className="editor-section__title">
                    <h3>Cue stack</h3>
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
                  <ol className="cue-list">
                    {selected.cues.map((item) => (
                      <li
                        key={item.id}
                        className={cueId === item.id ? "is-active" : ""}
                      >
                        <button type="button" onClick={() => setCueId(item.id)}>
                          <b>{item.operatorLabel}</b>
                          <small>
                            {item.operations
                              .map((operation) =>
                                operation.kind === "visual"
                                  ? operation.visual.kind
                                  : operation.kind === "audio"
                                    ? `AUDIO ${operation.action}`
                                    : `WAIT ${operation.durationMs}ms`,
                              )
                              .join(" + ")}
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
                      Visual action
                      <select
                        value={cue.visualKind}
                        onChange={(event) =>
                          setCue((current) => ({
                            ...current,
                            visualKind: event.target.value as VisualChoice,
                          }))
                        }
                      >
                        <option value="">Leave visual unchanged</option>
                        <option value="TITLE_CARD">Title card</option>
                        <option value="IMAGE">Image</option>
                        <option value="SLIDES">Slide image</option>
                        <option value="VIDEO">Video</option>
                        <option value="BLACK">Black</option>
                        <option value="CLEAR">Clear visual</option>
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
                        Visual media
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
                          {visualAssets
                            .filter((asset) =>
                              cue.visualKind === "VIDEO"
                                ? asset.mimeType.startsWith("video/")
                                : asset.mimeType.startsWith("image/"),
                            )
                            .map((asset) => (
                              <option key={asset.id} value={asset.id}>
                                {asset.originalFilename}
                              </option>
                            ))}
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
                      Backing audio action
                      <select
                        value={cue.audioAction}
                        onChange={(event) =>
                          setCue((current) => ({
                            ...current,
                            audioAction: event.target.value as AudioChoice,
                          }))
                        }
                      >
                        <option value="">Leave audio unchanged</option>
                        <option value="LOAD">Load / play selected audio</option>
                        <option value="PLAY">Play selected/current</option>
                        <option value="PAUSE">Pause</option>
                        <option value="RESUME">Resume</option>
                        <option value="STOP">Stop</option>
                        <option value="REPLAY">Replay from start</option>
                        <option value="SEEK">Seek and play</option>
                      </select>
                    </label>
                    {(cue.audioAction === "LOAD" ||
                      cue.audioAction === "PLAY") && (
                      <label>
                        Audio media
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
                    <button type="submit">
                      {currentCue ? "SAVE CUE" : "ADD CUE"}
                    </button>
                  </form>
                </section>
              </>
            )}
          </>
        ) : (
          <div className="empty-state">
            <strong>Select an act</strong>
            <span>Choose an act from the running order or add a new one.</span>
          </div>
        )}
      </div>
      {notice && (
        <output className="editor-notice" role="status">
          {notice}
        </output>
      )}
    </div>
  );
}
