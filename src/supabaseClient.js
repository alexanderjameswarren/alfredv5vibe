import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://zuqjyfqnvhddnchhpbcz.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo'; // Paste your anon public key here

export const supabase = createClient(supabaseUrl, supabaseAnonKey);