// uploadAudio: a failure at any step leaves the song as it was, and a
// replacement only removes the old file once the song points at the new one.

import { uploadAudio } from "./audioPlayer";

function fakeSupabase({ uploadError = null, updateError = null } = {}) {
  const calls = [];
  const client = {
    storage: {
      from: (bucket) => ({
        upload: async (path) => {
          calls.push(["upload", bucket, path]);
          return { error: uploadError };
        },
        remove: async (paths) => {
          calls.push(["remove", bucket, paths]);
          return { error: null };
        },
      }),
    },
    from: (table) => ({
      update: (payload) => ({
        eq: async (col, id) => {
          calls.push(["update", table, payload, id]);
          return { error: updateError };
        },
      }),
    }),
  };
  return { client, calls };
}

const FILE = new Blob(["mp3"], { type: "audio/mpeg" });
const OLD = "u1/song-1-100.mp3";

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("a first upload writes only audio_file_path and removes nothing", async () => {
  const { client, calls } = fakeSupabase();
  const path = await uploadAudio("song-1", FILE, "u1", client, null);
  expect(path).toMatch(/^u1\/song-1-\d+\.mp3$/);
  expect(calls.map((c) => c[0])).toEqual(["upload", "update"]);
  expect(calls[1][2]).toEqual({ audio_file_path: path });
});

test("a replacement removes the old file only after the song points at the new one", async () => {
  const { client, calls } = fakeSupabase();
  const path = await uploadAudio("song-1", FILE, "u1", client, OLD);
  expect(calls.map((c) => c[0])).toEqual(["upload", "update", "remove"]);
  expect(calls[2][2]).toEqual([OLD]);
  expect(path).not.toBe(OLD);
});

test("a failed upload throws and changes nothing — the old file survives", async () => {
  const { client, calls } = fakeSupabase({ uploadError: { message: "too big" } });
  await expect(uploadAudio("song-1", FILE, "u1", client, OLD)).rejects.toThrow(/too big/);
  expect(calls.map((c) => c[0])).toEqual(["upload"]);
});

test("a failed song update throws, discards the new file, and keeps the old one", async () => {
  const { client, calls } = fakeSupabase({ updateError: { message: "denied" } });
  await expect(uploadAudio("song-1", FILE, "u1", client, OLD)).rejects.toThrow(/denied/);
  const removes = calls.filter((c) => c[0] === "remove");
  expect(removes).toHaveLength(1);
  expect(removes[0][2]).not.toContain(OLD);
});
