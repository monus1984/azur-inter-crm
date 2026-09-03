import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Profile } from "../types/database";

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
}

// Ce hook centralise la session Supabase et le profil applicatif (rôle,
// nom, agence). Toute page qui a besoin de savoir "qui est connecté et
// avec quel rôle" passe par ici plutôt que de refaire la requête.
export function useAuth(): AuthState {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    supabase
      .from("profiles")
      .select("*")
      .eq("id", session.user.id)
      .single()
      .then(({ data, error }) => {
        if (error) {
          console.error("Erreur chargement profil:", error.message);
          setProfile(null);
        } else {
          setProfile(data as Profile);
        }
        setLoading(false);
      });
  }, [session]);

  return { session, profile, loading };
}
