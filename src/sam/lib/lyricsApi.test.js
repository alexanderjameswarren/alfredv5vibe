const mockOps = [];
jest.mock("../../supabaseClient", () => ({
  supabase: {
    from: (table) => ({
      delete: () => ({
        eq: async (col, val) => {
          mockOps.push({ op: "delete", table, val });
          return { error: null };
        },
      }),
      insert: async (rows) => {
        mockOps.push({ op: "insert", table, rows });
        return { error: null };
      },
    }),
  },
}));
jest.mock("./measureCompiler", () => ({
  recompileMeasures: async () => {
    mockOps.push({ op: "recompile" });
    return ["recompiled"];
  },
}));

jest.mock("./lyricsSplit", () => {
  const actual = jest.requireActual("./lyricsSplit");
  return {
    ...actual,
    loadSplitter: async () => ({
      dict: actual.parseSyllableDict("nev|er\nmind\n"),
      hyphenate: jest.requireActual("hyphen/en-us").hyphenateSync,
    }),
  };
});

const { saveSongLyrics, deleteSongLyrics } = require("./lyricsApi");

const MEASURES = [{ number: 1, rh: [{ notes: [{ pitch: "C4" }] }, { notes: [{ pitch: "D4" }] }] }];

beforeEach(() => { mockOps.length = 0; });

test("save replaces rows already matched, then recompiles", async () => {
  const res = await saveSongLyrics("s1", "Never mind", MEASURES);
  expect(mockOps.map((o) => o.op)).toEqual(["delete", "insert", "recompile"]);
  expect(mockOps[1].rows).toEqual([
    { song_id: "s1", word_order: 1, syllable: "Nev-", measure_num: 1, rh_index: 0 },
    { song_id: "s1", word_order: 2, syllable: "er", measure_num: 1, rh_index: 1 },
    { song_id: "s1", word_order: 3, syllable: "mind", measure_num: null, rh_index: null },
  ]);
  expect(res.unplaced).toBe(1);
  expect(res.measures).toEqual(["recompiled"]);
});

test("save refuses empty text and writes nothing", async () => {
  await expect(saveSongLyrics("s1", "  \n", MEASURES)).rejects.toThrow("No lyrics");
  expect(mockOps).toEqual([]);
});

test("delete removes rows then recompiles", async () => {
  expect(await deleteSongLyrics("s1")).toEqual(["recompiled"]);
  expect(mockOps.map((o) => o.op)).toEqual(["delete", "recompile"]);
});
