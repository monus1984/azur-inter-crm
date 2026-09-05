import { useState, useEffect } from "react";

// Persiste un état dans sessionStorage : survit à la navigation entre pages
// de la SPA (qui démonte le composant) et à un rechargement de l'onglet,
// mais s'efface à la fermeture de l'onglet. Utilisé pour l'import — le texte
// collé et la relecture en cours ne doivent pas se perdre si l'utilisateur
// change d'onglet par mégarde.
export function usePersistentState<T>(key: string, initial: T) {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Stockage plein ou indisponible : on continue sans persister plutôt
      // que de casser l'import en cours.
    }
  }, [key, state]);

  return [state, setState] as const;
}
