import { Routes, Route } from "react-router";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import Game from "./pages/Game";
import { Toaster } from "sonner";
import { lazy, Suspense } from "react";

// C2: admin + login + 404 are split out of the player bundle.
const Login = lazy(() => import("./pages/Login"));
const Admin = lazy(() => import("./pages/Admin"));
const NotFound = lazy(() => import("./pages/NotFound"));
// F3: legal pages (Terms / Privacy / Responsible Gaming).
const TermsPage = lazy(() => import("./pages/Legal").then((m) => ({ default: m.TermsPage })));
const PrivacyPage = lazy(() => import("./pages/Legal").then((m) => ({ default: m.PrivacyPage })));
const ResponsibleGamingPage = lazy(() => import("./pages/Legal").then((m) => ({ default: m.ResponsibleGamingPage })));

function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<div className="min-h-screen bg-[#0A0A0F]" />}>
      <Routes>
        <Route path="/" element={<Game />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/login" element={<Login />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/responsible-gaming" element={<ResponsibleGamingPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </Suspense>
      <Toaster richColors position="top-center" />
    </ErrorBoundary>
  );
}

export default App;
