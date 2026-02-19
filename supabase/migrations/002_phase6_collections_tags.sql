-- Phase 6 migration: Collections, Tags, and Collection References
-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard -> SQL Editor)

-- ============================================================
-- item_collections — stores named collections of items
-- ============================================================
CREATE TABLE item_collections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  context_id TEXT,
  shared BOOLEAN DEFAULT false,
  is_capture_target BOOLEAN DEFAULT false,
  items JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_item_collections_user_id ON item_collections (user_id);
CREATE INDEX idx_item_collections_context_id ON item_collections (context_id);
CREATE INDEX idx_item_collections_shared ON item_collections (shared);

-- RLS policies for item_collections
ALTER TABLE item_collections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own collections"
  ON item_collections FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can view shared collections"
  ON item_collections FOR SELECT
  USING (shared = true);

CREATE POLICY "Users can modify their own collections"
  ON item_collections FOR ALL
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can modify shared collections"
  ON item_collections FOR UPDATE
  USING (shared = true);

-- ============================================================
-- Add tags columns (JSONB arrays with GIN indexes)
-- ============================================================
ALTER TABLE items ADD COLUMN tags JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX idx_items_tags ON items USING GIN (tags);

ALTER TABLE intents ADD COLUMN tags JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX idx_intents_tags ON intents USING GIN (tags);

ALTER TABLE contexts ADD COLUMN tags JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX idx_contexts_tags ON contexts USING GIN (tags);

-- ============================================================
-- Add collection_id references
-- ============================================================
ALTER TABLE intents ADD COLUMN collection_id TEXT;
CREATE INDEX idx_intents_collection_id ON intents (collection_id);

ALTER TABLE events ADD COLUMN collection_id TEXT;
CREATE INDEX idx_events_collection_id ON events (collection_id);

ALTER TABLE executions ADD COLUMN collection_id TEXT;
CREATE INDEX idx_executions_collection_id ON executions (collection_id);

-- ============================================================
-- Add completed_item_ids to executions
-- ============================================================
ALTER TABLE executions ADD COLUMN completed_item_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
