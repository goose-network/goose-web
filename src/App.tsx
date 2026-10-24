// src/App.tsx — shell: topbar (brand, connection, theme) + grouped sidebar
// nav (off-canvas drawer below 960px) + routed pages.

import { useEffect, useState, type ComponentType } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { ConnectionBanner } from "./ConnectionBanner";
import { ThemeToggle } from "./components/ThemeToggle";
import {
  BrandMark,
  IconChart,
  IconCloud,
  IconGauge,
  IconGlobe,
  IconInbound,
  IconLayers,
  IconLink,
  IconMenu,
  IconOutbound,
} from "./components/icons";
import { EnginePage } from "./pages/EnginePage";
import { InboundsPage } from "./pages/InboundsPage";
import { OutboundsPage } from "./pages/OutboundsPage";
import { PoolsPage } from "./pages/PoolsPage";
import { ChainsPage } from "./pages/ChainsPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { MetricsPage } from "./pages/MetricsPage";
import { ExitChecksPage } from "./pages/ExitChecksPage";

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType;
  end?: boolean;
}

const NAV: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Engine",
    items: [{ to: "/", label: "Overview", Icon: IconGauge, end: true }],
  },
  {
    label: "Routing",
    items: [
      { to: "/inbounds", label: "Inbounds", Icon: IconInbound },
      { to: "/outbounds", label: "Outbounds", Icon: IconOutbound },
      { to: "/pools", label: "Pools", Icon: IconLayers },
      { to: "/chains", label: "Chains", Icon: IconLink },
      { to: "/providers", label: "Providers", Icon: IconCloud },
    ],
  },
  {
    label: "Observe",
    items: [
      { to: "/exit-checks", label: "Exit IP", Icon: IconGlobe },
      { to: "/metrics", label: "Metrics", Icon: IconChart },
    ],
  },
];

export function App() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  // Navigating from the drawer closes it; the page underneath is the point.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  return (
    // viz-root scopes the palette custom properties (light + dark); without
    // it every var(--…) token in styles.css/charts.css resolves to nothing.
    <div className="viz-root app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <button
          type="button"
          className="nav-toggle ghost"
          aria-expanded={navOpen}
          aria-controls="sidebar"
          onClick={() => setNavOpen((v) => !v)}
        >
          <IconMenu size={17} />
          <span className="nav-toggle-label">Menu</span>
        </button>
        <NavLink to="/" className="brand" aria-label="goose — overview">
          <BrandMark />
          <span className="brand-name">goose</span>
        </NavLink>
        <div className="spacer" />
        <ConnectionBanner />
        <ThemeToggle />
      </header>

      {navOpen && (
        <button
          type="button"
          className="backdrop"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        />
      )}

      <aside className={`sidebar${navOpen ? " open" : ""}`} id="sidebar">
        {NAV.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-label">{group.label}</div>
            <nav aria-label={group.label}>
              {group.items.map(({ to, label, Icon, end }) => (
                <NavLink key={to} to={to} end={end === true}>
                  <Icon />
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
        ))}
      </aside>

      <main className="main" id="main">
        <div className="page-body">
          <Routes>
            <Route path="/" element={<EnginePage />} />
            <Route path="/inbounds" element={<InboundsPage />} />
            <Route path="/outbounds" element={<OutboundsPage />} />
            <Route path="/pools" element={<PoolsPage />} />
            <Route path="/chains" element={<ChainsPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/exit-checks" element={<ExitChecksPage />} />
            <Route path="/metrics" element={<MetricsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <>
      <h1 className="page-title">Page not found</h1>
      <p className="page-sub">
        Nothing lives at this address.{" "}
        <NavLink to="/">Back to the overview</NavLink>.
      </p>
    </>
  );
}
