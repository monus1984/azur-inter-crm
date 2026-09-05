import { BrowserRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import { useAuth } from "./lib/useAuth";
import { supabase } from "./lib/supabase";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Ventes from "./pages/Ventes";
import SaisieVente from "./pages/SaisieVente";
import Validation from "./pages/Validation";
import ImportPDF from "./pages/ImportPDF";
import Backlog from "./pages/Backlog";
import type { Profile } from "./types/database";

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

function Shell({ children, profile }: { children: React.ReactNode; profile: Profile }) {
  const isAdmin = profile.role === "admin";
  const isCommercial = profile.role === "commercial";
  const isSuperviseur = profile.role === "superviseur";

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="font-semibold text-slate-900 mr-4">Azur Inter</span>
            <NavItem to="/" label="Dashboard" />
            <NavItem to="/ventes" label="Ventes" />
            {(isCommercial || isAdmin) && <NavItem to="/saisie" label="+ Vente" />}
            {(isCommercial || isAdmin) && <NavItem to="/import-pdf" label="Import PDF" />}
            {isAdmin && <NavItem to="/validation" label="Validation" />}
            {(isAdmin || isSuperviseur) && <NavItem to="/backlog" label="Backlog" />}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400 uppercase tracking-wide">{profile.role}</span>
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

  // Le superviseur ne saisit et n'importe jamais de vente : ces deux routes
  // lui restent fermées, tout comme au DG et à OCI. Il ne fait que consulter
  // et compléter le backlog.
  const peutSaisirOuImporter = profile.role === "admin" || profile.role === "commercial";

  return (
    <BrowserRouter>
      <Shell profile={profile}>
        <Routes>
          <Route path="/" element={<Dashboard profile={profile} />} />
          <Route path="/ventes" element={<Ventes profile={profile} />} />
          <Route
            path="/saisie"
            element={!peutSaisirOuImporter ? <Navigate to="/" replace /> : <SaisieVente profile={profile} />}
          />
          <Route
            path="/import-pdf"
            element={!peutSaisirOuImporter ? <Navigate to="/" replace /> : <ImportPDF profile={profile} />}
          />
          <Route
            path="/validation"
            element={profile.role !== "admin" ? <Navigate to="/" replace /> : <Validation profile={profile} />}
          />
          <Route
            path="/backlog"
            element={
              profile.role !== "admin" && profile.role !== "superviseur"
                ? <Navigate to="/" replace />
                : <Backlog profile={profile} />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}
