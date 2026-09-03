import { BrowserRouter, Routes, Route, Navigate, Link } from "react-router-dom";
import { useAuth } from "./lib/useAuth";
import { supabase } from "./lib/supabase";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Ventes from "./pages/Ventes";

function Shell({
  children,
  nom,
}: {
  children: React.ReactNode;
  nom: string;
}) {
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200 px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="font-semibold text-slate-900">Azur Inter</span>
          <Link to="/" className="text-sm text-slate-600 hover:text-slate-900">
            Dashboard
          </Link>
          <Link
            to="/ventes"
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Ventes
          </Link>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-500">{nom}</span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-sm text-slate-500 hover:text-slate-900"
          >
            Déconnexion
          </button>
        </div>
      </nav>
      {children}
    </div>
  );
}

export default function App() {
  const { session, profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm">
        Chargement...
      </div>
    );
  }

  if (!session) {
    return <Login />;
  }

  if (!profile) {
    // Session valide mais pas de profil applicatif : le compte existe dans
    // auth.users mais pas dans la table profiles. Cas à traiter par l'admin.
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm p-8 text-center">
        Votre compte est authentifié mais aucun profil n'est associé.
        Contactez l'administrateur.
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Shell nom={profile.nom}>
        <Routes>
          <Route path="/" element={<Dashboard profile={profile} />} />
          <Route path="/ventes" element={<Ventes />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}
