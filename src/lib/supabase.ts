import { createClient } from "@supabase/supabase-js";

// Les deux valeurs viennent du fichier .env (jamais commité).
// Project Settings > API dans le dashboard Supabase.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY doivent être définies dans .env"
  );
}

// La clé anon est publique par design : c'est le RLS côté base qui protège
// les données, pas le secret de cette clé. Voir schema_lot1.sql section 8.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
