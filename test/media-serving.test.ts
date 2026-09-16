import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { serveMediaAsset, uploadMediaAsset } from "../worker/media-assets";
import { PRIMARY_SHOW_ID } from "../worker/show-state";
import { upsertShow } from "../worker/show-config";

/**
 * The projector's media element and its service worker both depend on the
 * media route answering exactly what HTTP promises: a whole object is a 200,
 * a Range request is a 206 whose Content-Range describes the bytes actually
 * returned. A 206 to a request that never asked for a range is treated by
 * browsers as a network failure, which is how the hall lost all its audio.
 */
describe("media asset serving", () => {
  it("answers whole-object and range requests with correct status and headers", async () => {
    const stub = env.SHOW_COORDINATOR.get(
      env.SHOW_COORDINATOR.idFromName("media-serving-ranges"),
    );
    await stub.fetch("https://show.internal/health");

    await runInDurableObject(stub, async (_instance, state) => {
      const { storage } = state;
      upsertShow(storage, PRIMARY_SHOW_ID, {
        title: "Range Check",
        tagline: "",
        shortName: "Range",
        themeId: "crimson",
        fontFamily: "system-ui",
        reactionsEnabled: false,
      });
      const bytes = Uint8Array.from(
        { length: 1000 },
        (_, index) => index % 256,
      );
      const uploaded = await uploadMediaAsset(
        storage,
        env.MEDIA,
        PRIMARY_SHOW_ID,
        new Request("https://show.test/api/admin/media", {
          method: "POST",
          headers: {
            "Content-Type": "audio/wav",
            "Content-Length": String(bytes.length),
          },
          body: bytes,
        }),
        "track.wav",
      );
      expect(uploaded.ok).toBe(true);
      if (!uploaded.ok) return;
      const url = `https://show.test/api/media/${uploaded.asset.id}`;
      const serve = (headers: Record<string, string> = {}) =>
        serveMediaAsset(
          storage.sql,
          env.MEDIA,
          PRIMARY_SHOW_ID,
          uploaded.asset.id,
          new Request(url, { headers }),
        );

      const whole = await serve();
      expect(whole.status).toBe(200);
      expect(whole.headers.get("Content-Range")).toBeNull();
      expect(whole.headers.get("Content-Length")).toBe("1000");
      expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
      expect((await whole.arrayBuffer()).byteLength).toBe(1000);

      const head = await serve({ Range: "bytes=0-99" });
      expect(head.status).toBe(206);
      expect(head.headers.get("Content-Range")).toBe("bytes 0-99/1000");
      expect(head.headers.get("Content-Length")).toBe("100");
      const headBytes = new Uint8Array(await head.arrayBuffer());
      expect(headBytes.byteLength).toBe(100);
      expect(headBytes[99]).toBe(99);

      const tail = await serve({ Range: "bytes=900-" });
      expect(tail.status).toBe(206);
      expect(tail.headers.get("Content-Range")).toBe("bytes 900-999/1000");
      expect((await tail.arrayBuffer()).byteLength).toBe(100);

      const suffix = await serve({ Range: "bytes=-50" });
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get("Content-Range")).toBe("bytes 950-999/1000");
      expect((await suffix.arrayBuffer()).byteLength).toBe(50);

      const clamped = await serve({ Range: "bytes=990-5000" });
      expect(clamped.status).toBe(206);
      expect(clamped.headers.get("Content-Range")).toBe("bytes 990-999/1000");

      const invalid = await serve({ Range: "bytes=5000-6000" });
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get("Content-Range")).toBe("bytes */1000");
    });
  });
});
