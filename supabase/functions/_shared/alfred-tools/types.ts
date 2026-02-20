export interface Context {
  id: string;
  name: string;
  description: string | null;
  keywords: string | null;
  shared: boolean;
  pinned: boolean;
  created_at: number;
  user_id: string | null;
  tags: string[];
}

export interface Item {
  id: string;
  name: string;
  description: string | null;
  context_id: string | null;
  elements: unknown[];
  is_capture_target: boolean;
  created_at: number;
  archived: boolean;
  user_id: string | null;
  tags: string[];
}

export interface Intent {
  id: string;
  text: string;
  created_at: number;
  is_intention: boolean;
  is_item: boolean;
  archived: boolean;
  item_id: string | null;
  context_id: string | null;
  recurrence: string;
  user_id: string | null;
  tags: string[];
  collection_id: string | null;
}

export interface Event {
  id: string;
  intent_id: string;
  time: string; // date as string
  item_ids: string[];
  context_id: string | null;
  archived: boolean;
  created_at: number;
  text: string | null;
  user_id: string | null;
  collection_id: string | null;
}

export interface Execution {
  id: string;
  event_id: string;
  intent_id: string;
  context_id: string | null;
  item_ids: string[];
  started_at: number;
  closed_at: number | null;
  status: string;
  outcome: string | null;
  progress: unknown[];
  notes: string | null;
  elements: unknown[];
  user_id: string | null;
  collection_id: string | null;
  completed_item_ids: string[];
}

export interface InboxItem {
  id: string;
  created_at: number;
  archived: boolean;
  triaged_at: number | null;
  captured_text: string;
  suggested_context_id: string | null;
  suggest_item: boolean;
  suggested_item_text: string | null;
  suggested_item_description: string | null;
  suggested_item_elements: unknown[] | null;
  suggest_intent: boolean;
  suggested_intent_text: string | null;
  suggested_intent_recurrence: string | null;
  suggest_event: boolean;
  suggested_event_date: string | null;
  user_id: string | null;
}

export interface ItemCollection {
  id: string;
  user_id: string;
  name: string;
  context_id: string | null;
  shared: boolean;
  is_capture_target: boolean;
  items: unknown[];
  created_at: string;
}

export interface ToolResult {
  data?: unknown;
  error?: string;
}
