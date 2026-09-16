/**
 * The test-show generator: turns a deterministic plan into real rows and real
 * (tiny, synthetic) media, in the same tables and through the same code paths
 * a real show uses, so what it exercises is the product and not a mock of it.
 *
 * Safety properties:
 *  - it replaces the show's *data* only after the caller has confirmed, and it
 *    keeps the show's configuration (name, theme, policy) so the operator can
 *    see their own setup with a full show inside it;
 *  - every fixture is written under `test-shows/<testShowId>/` in R2 and
 *    flagged `generated_test` in SQLite, so a reset and the orphan sweep can
 *    remove all of it without touching a real upload;
 *  - nothing here reads the network; the media bytes are generated in code.
 */

import {
  addAudienceScore,
  audienceWeight,
  emptyScoringAggregate,
  parseJudgeScore,
  transformJudgeScore,
} from "../shared/scoring";
import {
  createTestSeed,
  generateTestShowPlan,
  isTestScenarioId,
  isTestSeed,
  type TestActPlan,
  type TestScenarioId,
  type TestShowPlan,
} from "../shared/test-show";
import { isRecord } from "../shared/trust";
import { createAct, editAct, parseActInput } from "./acts";
import { recordAuditEvent } from "./audit";
import { insertMediaAssetRecord } from "./media-assets";
import {
  TEST_SHOW_OBJECT_PREFIX,
  drainMediaCleanupQueue,
} from "./media-cleanup";
import { finaliseResult } from "./results";
import { applyScoringConfiguration } from "./scoring-config";
import { clearShowData } from "./show-reset";

export const GENERATE_TEST_SHOW_CONFIRMATION = "GENERATE TEST SHOW";

export interface TestShowRequest {
  seed?: string;
  scenario?: TestScenarioId;
}

export type TestShowRequestParse =
  { ok: true; request: TestShowRequest } | { ok: false; reason: string };

export function parseTestShowRequest(value: unknown): TestShowRequestParse {
  if (!isRecord(value) || value.confirm !== GENERATE_TEST_SHOW_CONFIRMATION)
    return {
      ok: false,
      reason: `Type ${GENERATE_TEST_SHOW_CONFIRMATION} to confirm`,
    };
  const request: TestShowRequest = {};
  if (value.seed !== undefined && value.seed !== null && value.seed !== "") {
    const seed = typeof value.seed === "string" ? value.seed.toUpperCase() : "";
    if (!isTestSeed(seed))
      return { ok: false, reason: "A seed is eight hexadecimal characters" };
    request.seed = seed;
  }
  if (
    value.scenario !== undefined &&
    value.scenario !== null &&
    value.scenario !== ""
  ) {
    if (!isTestScenarioId(value.scenario))
      return { ok: false, reason: "Unknown test scenario" };
    request.scenario = value.scenario;
  }
  return { ok: true, request };
}

export interface TestShowSummary {
  testShowId: string;
  seed: string;
  scenario: TestScenarioId;
  scenarioLabel: string;
  acts: number;
  votes: number;
  judgeSubmissions: number;
  finalised: number;
  assets: number;
  /** Asset rows whose object is deliberately absent from storage. */
  brokenAssets: number;
  /** Objects from the previous show data that R2 refused to delete. */
  objectsPending: number;
}

/** Whether any show data exists that generation would replace. */
export function showDataExists(
  sql: SqlStorage,
  showIdentifier: string,
): boolean {
  return (
    sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM acts WHERE show_id = ?
         UNION ALL SELECT 1 FROM media_assets WHERE show_id = ?
         UNION ALL SELECT 1 FROM audience_votes WHERE show_id = ? LIMIT 1`,
        showIdentifier,
        showIdentifier,
        showIdentifier,
      )
      .toArray().length > 0
  );
}

// ---------------------------------------------------------------------------
// Synthetic media. A real PNG and a real WAV, small enough to generate in a
// few microseconds and honest enough for the projector to decode.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeUint32(chunk, 0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  writeUint32(
    chunk,
    8 + data.length,
    crc32(chunk.subarray(4, 8 + data.length)),
  );
  return chunk;
}

/** A solid-colour PNG with a lighter diagonal band, stored (uncompressed) deflate. */
export function syntheticPng(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Uint8Array {
  const rowLength = 1 + width * 3;
  const raw = new Uint8Array(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowLength] = 0;
    for (let x = 0; x < width; x += 1) {
      const band = Math.abs(x - y) < Math.max(2, width / 8);
      const offset = y * rowLength + 1 + x * 3;
      raw[offset] = band ? Math.min(255, rgb[0] + 70) : rgb[0];
      raw[offset + 1] = band ? Math.min(255, rgb[1] + 70) : rgb[1];
      raw[offset + 2] = band ? Math.min(255, rgb[2] + 70) : rgb[2];
    }
  }
  // zlib stream: header, one stored block, adler32.
  const zlib = new Uint8Array(2 + 5 + raw.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib[2] = 0x01;
  zlib[3] = raw.length & 0xff;
  zlib[4] = (raw.length >>> 8) & 0xff;
  zlib[5] = ~raw.length & 0xff;
  zlib[6] = (~raw.length >>> 8) & 0xff;
  zlib.set(raw, 7);
  writeUint32(zlib, 7 + raw.length, adler32(raw));

  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.length;
  }
  return png;
}

/** Silent 16-bit mono PCM WAV of the given duration. */
export function syntheticWav(seconds: number, sampleRate = 8000): Uint8Array {
  const samples = Math.round(seconds * sampleRate);
  const dataLength = samples * 2;
  const wav = new Uint8Array(44 + dataLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) =>
    wav.set(new TextEncoder().encode(text), offset);
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataLength, true);
  return wav;
}

// ---------------------------------------------------------------------------

function voterHashFor(actIndex: number, voteIndex: number): ArrayBuffer {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x7e57_0000 + actIndex);
  view.setUint32(4, voteIndex);
  view.setUint32(8, 0x5eed);
  return bytes.buffer;
}

interface GeneratedAsset {
  id: string;
  broken: boolean;
}

async function writeFixture(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
  testShowId: string,
  actIdentifier: string,
  fixture: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    width?: number;
    height?: number;
    durationMs?: number;
    broken: boolean;
  },
  timestamp: string,
): Promise<GeneratedAsset> {
  const id = `asset-${crypto.randomUUID()}`;
  const objectKey = `${TEST_SHOW_OBJECT_PREFIX}${testShowId}/${id}`;
  let version = `test-${id}`;
  if (!fixture.broken) {
    const object = await bucket.put(objectKey, fixture.bytes, {
      httpMetadata: { contentType: fixture.mimeType },
      customMetadata: {
        assetId: id,
        actId: actIdentifier,
        generatedTest: "true",
        testShowId,
      },
    });
    version = object.version;
  }
  insertMediaAssetRecord(
    storage.sql,
    showIdentifier,
    {
      id,
      objectKey,
      originalFilename: fixture.filename,
      mimeType: fixture.mimeType,
      sizeBytes: fixture.bytes.length,
      versionIdentifier: version,
      actId: actIdentifier,
      width: fixture.width ?? null,
      height: fixture.height ?? null,
      durationMs: fixture.durationMs ?? null,
      generatedTest: true,
      testShowId,
    },
    timestamp,
  );
  return { id, broken: fixture.broken };
}

function colourFor(index: number): [number, number, number] {
  const palette: [number, number, number][] = [
    [30, 90, 160],
    [160, 60, 40],
    [40, 140, 90],
    [130, 80, 170],
    [180, 130, 30],
    [40, 120, 150],
  ];
  return palette[index % palette.length]!;
}

/**
 * Replaces the show's data with a generated show. Configuration (name, theme,
 * font, GO policy) is kept; the judge panel is replaced by the plan's, because
 * the scenario decides how many judges it needs.
 */
export async function generateTestShow(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  showIdentifier: string,
  request: TestShowRequest,
  random: () => number = Math.random,
): Promise<TestShowSummary> {
  const seed = request.seed ?? createTestSeed(random);
  const plan: TestShowPlan = generateTestShowPlan(seed, request.scenario);
  const testShowId = `test-${seed.toLowerCase()}-${crypto
    .randomUUID()
    .slice(0, 8)}`;
  const timestamp = new Date().toISOString();

  // 1. Out with the old show data (configuration stays), R2 work queued.
  storage.transactionSync(() => {
    clearShowData(storage.sql, showIdentifier);
  });
  const cleanup = await drainMediaCleanupQueue(
    storage,
    bucket,
    showIdentifier,
    1000,
  );

  // 2. The judge panel the scenario needs. Scoring data is gone, so this
  //    cannot lock; extra judges from the previous panel become inactive.
  const judges = await applyScoringConfiguration(storage, showIdentifier, {
    judgeNames: plan.judgeNames,
    audienceWeight: plan.audienceWeight,
    reset: false,
    confirm: null,
  });
  if (!judges.ok) throw new Error(judges.reason);
  const judgeIds = storage.sql
    .exec<{ id: string }>(
      "SELECT id FROM show_judges WHERE show_id = ? AND active = 1 ORDER BY slot",
      showIdentifier,
    )
    .toArray()
    .map((row) => row.id);

  // 3. Acts, their media libraries and their presentation.
  const actIds: string[] = [];
  let assets = 0;
  let brokenAssets = 0;
  for (const [index, act] of plan.acts.entries()) {
    const created = createAct(storage, showIdentifier, baseActInput(act));
    if (!created) throw new Error("Show unavailable while generating");
    actIds.push(created.id);

    let image: GeneratedAsset | null = null;
    let audio: GeneratedAsset | null = null;
    if (act.media.image) {
      image = await writeFixture(
        storage,
        bucket,
        showIdentifier,
        testShowId,
        created.id,
        {
          filename: `portrait-${index + 1}.png`,
          mimeType: "image/png",
          bytes: syntheticPng(64, 36, colourFor(index)),
          width: 64,
          height: 36,
          broken: act.media.brokenImage,
        },
        timestamp,
      );
      assets += 1;
      if (image.broken) brokenAssets += 1;
    }
    if (act.media.audio) {
      audio = await writeFixture(
        storage,
        bucket,
        showIdentifier,
        testShowId,
        created.id,
        {
          filename: `backing-${index + 1}.wav`,
          mimeType: "audio/wav",
          bytes: syntheticWav(1.5),
          durationMs: 1500,
          broken: false,
        },
        timestamp,
      );
      assets += 1;
    }
    const edited = editAct(storage, showIdentifier, created.id, {
      ...baseActInput(act),
      publicImageAssetId: image?.id ?? null,
      presentation: {
        actImageAssetId: image?.id ?? null,
        performanceMode:
          act.performanceVisual === "IMAGE" && image ? "CUSTOM" : "DEFAULT",
        performanceVisualMode:
          act.performanceVisual === "IMAGE" && image ? "IMAGE" : "AUTOMATIC",
        performanceAssetId:
          act.performanceVisual === "IMAGE" && image ? image.id : null,
        performanceFit: "contain",
        backingAudioAssetId: audio?.id ?? null,
        backingAudioStart: act.backingAudioStart,
      },
    });
    if (!edited) throw new Error("Generated act could not be saved");
  }

  // 4. Votes, judge scores and frozen results, written as the live paths
  //    would have written them.
  let votes = 0;
  let judgeSubmissions = 0;
  let finalised = 0;
  storage.transactionSync(() => {
    for (const [index, act] of plan.acts.entries()) {
      const id = actIds[index]!;
      if (act.audienceScores.length > 0) {
        let aggregate = emptyScoringAggregate();
        for (const [voteIndex, score] of act.audienceScores.entries()) {
          aggregate = addAudienceScore(aggregate, score);
          storage.sql.exec(
            `INSERT INTO audience_votes (show_id, act_id, voter_id_hash, score, weight, weighted_score, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            showIdentifier,
            id,
            voterHashFor(index, voteIndex),
            score,
            audienceWeight(score),
            score * audienceWeight(score),
            timestamp,
          );
          votes += 1;
        }
        storage.sql.exec(
          `INSERT INTO audience_aggregates (show_id, act_id, vote_count, weighted_sum, total_weight, weighted_mean, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          showIdentifier,
          id,
          aggregate.count,
          aggregate.weightedSum,
          aggregate.totalWeight,
          aggregate.weightedMean,
          timestamp,
        );
      }
      act.judgeScores.forEach((raw, slot) => {
        const judgeId = judgeIds[slot];
        if (raw === null || !judgeId) return;
        const parsed = parseJudgeScore(raw);
        if (!parsed.ok) return;
        storage.sql.exec(
          `INSERT INTO show_judge_submissions (show_id, act_id, judge_id, raw_input,
             parsed_classification, finite_value, effective_score, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          showIdentifier,
          id,
          judgeId,
          raw,
          parsed.parsed.classification,
          parsed.parsed.finiteValue,
          transformJudgeScore(parsed.parsed),
          timestamp,
        );
        judgeSubmissions += 1;
      });
      if (act.finalised) {
        const result = finaliseResult(storage.sql, showIdentifier, id);
        if (result.ok) finalised += 1;
      }
      if (act.withdrawn) {
        storage.sql.exec(
          "UPDATE acts SET withdrawn_at = ? WHERE show_id = ? AND id = ?",
          timestamp,
          showIdentifier,
          id,
        );
      }
    }

    // 5. Where the evening is: current act, display, flow step, voting and
    //    the public results stage.
    const currentId =
      plan.currentActIndex === null ? null : actIds[plan.currentActIndex]!;
    const currentFinalised =
      plan.currentActIndex !== null &&
      plan.acts[plan.currentActIndex]!.finalised;
    storage.sql.exec(
      `UPDATE shows SET active_act_id = ?, display_mode = ?, audience_vote_state = ?,
         result_reveal_state = 'HIDDEN', revision = revision + 1, updated_at = ?
       WHERE id = ?`,
      currentId,
      plan.displayMode,
      plan.votingOpen && currentId && !currentFinalised ? "OPEN" : "CLOSED",
      timestamp,
      showIdentifier,
    );
    storage.sql.exec(
      `UPDATE show_runtime SET flow_step = ?, results_stage = ?, results_revealed_groups = 0,
         global_judge_permission = ?, updated_at = ?
       WHERE show_id = ?`,
      currentId ? plan.flowStep : null,
      finalised > 0 ? plan.resultsStage : "HIDDEN",
      plan.flowStep === "SCORING" ? "OPEN" : "CLOSED",
      timestamp,
      showIdentifier,
    );
    storage.sql.exec(
      `INSERT INTO test_show_generations (show_id, test_show_id, seed, scenario, generated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(show_id) DO UPDATE SET test_show_id = excluded.test_show_id,
         seed = excluded.seed, scenario = excluded.scenario, generated_at = excluded.generated_at`,
      showIdentifier,
      testShowId,
      plan.seed,
      plan.scenario,
      timestamp,
    );
    recordAuditEvent(storage.sql, showIdentifier, {
      type: "test_show.generated",
      actor: "admin",
      data: {
        seed: plan.seed,
        scenario: plan.scenario,
        acts: plan.acts.length,
        votes,
      },
    });
  });

  return {
    testShowId,
    seed: plan.seed,
    scenario: plan.scenario,
    scenarioLabel: plan.scenarioLabel,
    acts: plan.acts.length,
    votes,
    judgeSubmissions,
    finalised,
    assets,
    brokenAssets,
    objectsPending: cleanup.pending,
  };
}

function baseActInput(act: TestActPlan) {
  const parsed = parseActInput({
    performerName: act.performerName,
    performers: act.performers.map((name, index) => ({
      id: `performer-${index + 1}`,
      name,
    })),
    groupName: act.groupName,
    performerDisplayMode: "AUTOMATIC",
    schoolYear: act.schoolYear,
    actName: act.actName,
    actType: act.actType,
    publicDescription: act.publicDescription,
    internalNotes: act.internalNotes,
    publicImageAssetId: null,
    showDescriptionToAudience: act.showDescriptionToAudience,
    showImageToAudience: act.showImageToAudience,
    presentation: {
      performanceVisualMode: "AUTOMATIC",
      performanceAssetId: null,
      performanceFit: "contain",
      backingAudioAssetId: null,
      backingAudioStart: act.backingAudioStart,
    },
    appearance: { themeId: act.themeId, fontFamily: null },
  });
  if (!parsed) throw new Error("Generated act plan was not a valid act");
  return parsed;
}
