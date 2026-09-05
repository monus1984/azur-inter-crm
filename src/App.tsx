import { BrowserRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import { useAuth } from "./lib/useAuth";
import { supabase } from "./lib/supabase";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Ventes from "./pages/Ventes";
import SaisieVente from "./pages/SaisieVente";
import Validation from "./pages/Validation";
import ImportPDF from "./pages/ImportPDF";

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `text-sm px-3 py-1.5 rounded-md transition-colors ${
          isActive
            ? "bg-slate-100 text-slate-900 font-medium"
            : "text-slate-600 hover:text-slate-900"
        }`
      }
    >
      {label}
    </NavLink>
  );
}

function Shell({
  children,
  profile,
}: {
  children: React.ReactNode;
  profile: { nom: string; role: string };
}) {
  const isAdmin = profile.role === "admin";
  const isDG = profile.role === "dg";
  const isCommercial = profile.role === "commercial";

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="font-semibold text-slate-900 mr-4">Azur Inter</span>
            <NavItem to="/" label="Dashboard" />
            <NavItem to="/ventes" label="Ventes" />
            {(isCommercial || isAdmin) && (
              <NavItem to="/saisie" label="+ Vente" />
            )}
            {(isCommercial || isAdmin) && (
              <NavItem to="/import-pdf" label="Import PDF" />
            )}
            {isAdmin && (
              <NavItem to="/validation" label="Validation" />
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400 uppercase tracking-wide">
              {profile.role}
            </span>
            <span className="text-sm text-slate-600">{profile.nom}</span>
            <button
              onClick={() => supabase.auth.signOut()}
              className="text-xs text-slate-400 hover:text-slate-700"
            >
              Déconnexion
            </button>
          </div>
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

  if (!session) return <Login />;

  if (!profile) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm p-8 text-center">
        Compte authentifié mais aucun profil associé. Contactez l'administrateur.
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Shell profile={profile}>
        <Routes>
          <Route path="/" element={<Dashboard profile={profile} />} />
          <Route path="/ventes" element={<Ventes />} />
          <Route
            path="/saisie"
            element={
              profile.role === "dg" || profile.role === "oci"
                ? <Navigate to="/" replace />
                : <SaisieVente profile={profile} />
            }
          />
          <Route
            path="/import-pdf"
            element={
              profile.role === "dg" || profile.role === "oci"
                ? <Navigate to="/" replace />
                : <ImportPDF profile={profile} />
            }
          />
          <Route
            path="/validation"
            element={
              profile.role !== "admin"
                ? <Navigate to="/" replace />
                : <Validation profile={profile} />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}
