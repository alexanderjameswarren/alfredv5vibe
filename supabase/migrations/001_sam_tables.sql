-- Sam tables migration
-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard → SQL Editor)

-- ============================================================
-- sam_songs — stores imported songs with full notation as JSONB
-- ============================================================
CREATE TABLE sam_songs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL DEFAULT auth.uid(),
  title TEXT NOT NULL,
  artist TEXT,
  source TEXT,                           -- 'manual', 'musicxml', 'json_import'
  source_file TEXT,                      -- original filename
  key_signature TEXT,                    -- 'A major', 'C minor', etc.
  time_signature TEXT DEFAULT '4/4',
  default_bpm INTEGER DEFAULT 68,
  measures JSONB NOT NULL,               -- full notation data (array of measures)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sam_songs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own songs" ON sam_songs
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- sam_snippets — loop regions within songs
-- ============================================================
CREATE TABLE sam_snippets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL DEFAULT auth.uid(),
  song_id UUID REFERENCES sam_songs(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  start_measure INTEGER NOT NULL,
  end_measure INTEGER NOT NULL,
  rest_measures INTEGER DEFAULT 0,
  settings JSONB DEFAULT '{}',           -- {bpm, timingWindowMs, chordGroupMs, targetLinePosition}
  tags TEXT[] DEFAULT '{}',
  notes TEXT,                            -- user's free-form practice notes
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sam_snippets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own snippets" ON sam_snippets
  FOR ALL USING (auth.uid() = user_id);

CREATE INDEX idx_snippets_song ON sam_snippets(song_id);

-- ============================================================
-- sam_sessions — practice session records with per-beat events
-- ============================================================
CREATE TABLE sam_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL DEFAULT auth.uid(),
  song_id UUID REFERENCES sam_songs(id) NOT NULL,
  snippet_id UUID REFERENCES sam_snippets(id),  -- null if practicing full song
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  settings JSONB DEFAULT '{}',           -- snapshot of BPM, window, chord group at time of session
  summary JSONB DEFAULT '{}',            -- {totalBeats, hits, misses, partials, accuracyPercent, avgTimingDeltaMs, loopCount}
  events JSONB DEFAULT '[]',             -- array of per-beat event objects
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sam_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own sessions" ON sam_sessions
  FOR ALL USING (auth.uid() = user_id);

CREATE INDEX idx_sessions_song ON sam_sessions(song_id);
CREATE INDEX idx_sessions_snippet ON sam_sessions(snippet_id);
CREATE INDEX idx_sessions_started ON sam_sessions(started_at DESC);
