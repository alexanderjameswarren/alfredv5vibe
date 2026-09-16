// Uploading audio in the player updates the song the rest of the player reads,
// so the Edit Song dialog switches to the audio layout immediately — and a
// failed upload leaves the no-audio layout exactly as it was.

import React from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

// --- heavy children the test doesn't need ---------------------------------
jest.mock("./components/ScoreRenderer", () => () => null);
jest.mock("./components/ScrollEngine", () => () => null);
jest.mock("./lib/useMIDI", () => () => ({ connected: false, deviceName: null, lastNote: null }));

// --- audio storage --------------------------------------------------------
const mockUploadAudio = jest.fn();
const mockLoadAudio = jest.fn();
jest.mock("./lib/audioPlayer", () => ({
  uploadAudio: (...args) => mockUploadAudio(...args),
  loadAudio: (...args) => mockLoadAudio(...args),
}));

// --- the song ---------------------------------------------------------------
const mockFetchSongById = jest.fn();
jest.mock("./lib/songLoad", () => ({
  ...jest.requireActual("./lib/songLoad"),
  fetchSongById: (...args) => mockFetchSongById(...args),
}));

// --- Supabase: every read is empty, every write succeeds -------------------
const mockWrites = [];
jest.mock("../supabaseClient", () => {
  function query(table) {
    const q = { table, update: null };
    const api = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") {
            return (resolve, reject) => {
              if (q.update) mockWrites.push({ table, payload: q.update });
              return Promise.resolve({ data: [], count: 0, error: null }).then(resolve, reject);
            };
          }
          if (prop === "update") {
            return (payload) => { q.update = payload; return api; };
          }
          if (prop === "single" || prop === "maybeSingle") {
            return () => ({
              then: (resolve, reject) =>
                Promise.resolve({ data: null, error: null }).then(resolve, reject),
            });
          }
          return () => api;
        },
      }
    );
    return api;
  }
  return {
    supabase: {
      from: (table) => query(table),
      auth: {
        getUser: async () => ({ data: { user: { id: "u1" } } }),
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
    },
    supabaseUrl: "http://localhost",
    supabaseAnonKey: "anon",
  };
});

const SamPlayer = require("./SamPlayer").default;

const SONG_ID = "11111111-1111-1111-1111-111111111111";
const NO_AUDIO_SONG = {
  title: "Throwaway",
  artist: null,
  defaultBpm: 65,
  playbackSpeed: 100,
  goalBpm: 72,
  goalPlaybackSpeed: 100,
  audioFilePath: null,
  showImportedFingerings: true,
  measures: [
    {
      number: 1,
      timeSignature: { beats: 4, beatType: 4 },
      rh: [{ duration: "w", notes: [{ midi: 60, name: "C4" }] }],
      lh: [{ duration: "w", notes: [] }],
    },
  ],
};

function fakeAudioElement() {
  return {
    addEventListener() {},
    removeEventListener() {},
    pause() {},
    play() {},
    currentTime: 0,
    duration: 12,
    paused: true,
    muted: false,
    playbackRate: 1,
  };
}

function renderPlayer() {
  return render(
    <MemoryRouter
      initialEntries={[`/sam/songs/${SONG_ID}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <SamPlayer onBack={() => {}} />
    </MemoryRouter>
  );
}

async function uploadFile() {
  const input = document.querySelector('input[type="file"][accept*="mp3"]');
  const file = new File(["mp3"], "track.mp3", { type: "audio/mpeg" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

async function openDialog() {
  fireEvent.click(await screen.findByTitle("Edit song"));
  return within((await screen.findByRole("heading", { name: "Edit Song" })).closest("div.bg-card"));
}

beforeEach(() => {
  mockWrites.length = 0;
  mockUploadAudio.mockReset();
  mockLoadAudio.mockReset().mockResolvedValue(fakeAudioElement());
  mockFetchSongById.mockReset().mockResolvedValue({
    song: JSON.parse(JSON.stringify(NO_AUDIO_SONG)),
    row: { id: SONG_ID },
  });
  jest.spyOn(window, "alert").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// The tempo box (NumericSettings) reads the same song: BPM without audio,
// Playback Speed % with it.
const tempoBoxShowsAudio = () => screen.queryByText(/^Playback Speed %:/) !== null;
const tempoBoxShowsBpm = () => screen.queryByText(/^BPM:/) !== null;

test("before any upload the dialog shows the no-audio layout", async () => {
  renderPlayer();
  await screen.findByTitle("Edit song");
  expect(tempoBoxShowsBpm()).toBe(true);
  expect(tempoBoxShowsAudio()).toBe(false);
  const d = await openDialog();
  expect(d.getByText("Default BPM")).toBeInTheDocument();
  expect(d.getByLabelText("Goal BPM")).toHaveValue(72);
  expect(d.queryByLabelText("Goal Speed %")).not.toBeInTheDocument();
});

test("after a successful upload the dialog shows the audio layout, no reload", async () => {
  mockUploadAudio.mockResolvedValue(`u1/${SONG_ID}-1.mp3`);
  renderPlayer();
  await screen.findByTitle("Edit song");

  await uploadFile();

  expect(mockUploadAudio).toHaveBeenCalledWith(SONG_ID, expect.any(File), "u1", expect.anything(), null);
  // The player loads the new file — AudioControls and the mute row follow.
  await waitFor(() =>
    expect(mockLoadAudio).toHaveBeenCalledWith(SONG_ID, `u1/${SONG_ID}-1.mp3`, expect.anything())
  );
  expect(await screen.findByText("Mute audio")).toBeInTheDocument();
  expect(tempoBoxShowsAudio()).toBe(true);
  expect(tempoBoxShowsBpm()).toBe(false);

  const d = await openDialog();
  expect(d.getByText("Playback Speed %")).toBeInTheDocument();
  expect(d.getByLabelText("Goal Speed %")).toHaveValue(100);
  expect(d.queryByLabelText("Goal BPM")).not.toBeInTheDocument();
  // Heard goal = the default BPM at the stored goal speed.
  expect(d.getByText(/^Goal: 65 BPM\./)).toBeInTheDocument();

  // The upload itself wrote nothing else through the app.
  expect(mockWrites).toEqual([]);
});

test("a second upload replaces the file the song now points at", async () => {
  mockUploadAudio
    .mockResolvedValueOnce(`u1/${SONG_ID}-1.mp3`)
    .mockResolvedValueOnce(`u1/${SONG_ID}-2.mp3`);
  renderPlayer();
  await screen.findByTitle("Edit song");

  await uploadFile();
  await waitFor(() => expect(mockLoadAudio).toHaveBeenCalledTimes(1));
  await uploadFile();

  // The old path passed in is the first upload, not the stale null.
  expect(mockUploadAudio).toHaveBeenLastCalledWith(
    SONG_ID, expect.any(File), "u1", expect.anything(), `u1/${SONG_ID}-1.mp3`
  );
  await waitFor(() =>
    expect(mockLoadAudio).toHaveBeenLastCalledWith(SONG_ID, `u1/${SONG_ID}-2.mp3`, expect.anything())
  );
});

test("a failed upload leaves the no-audio layout and loads nothing", async () => {
  mockUploadAudio.mockRejectedValue(new Error("Upload failed: too big"));
  renderPlayer();
  await screen.findByTitle("Edit song");

  await uploadFile();

  await waitFor(() => expect(window.alert).toHaveBeenCalledWith(expect.stringMatching(/too big/)));
  expect(mockLoadAudio).not.toHaveBeenCalled();
  expect(screen.queryByText("Mute audio")).not.toBeInTheDocument();
  expect(tempoBoxShowsBpm()).toBe(true);
  expect(tempoBoxShowsAudio()).toBe(false);

  const d = await openDialog();
  expect(d.getByText("Default BPM")).toBeInTheDocument();
  expect(d.getByLabelText("Goal BPM")).toHaveValue(72);
  expect(d.queryByLabelText("Goal Speed %")).not.toBeInTheDocument();
});
