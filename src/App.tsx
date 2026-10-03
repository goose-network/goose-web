// src/App.tsx — shell: sidebar nav + connection banner + routed pages.

import { NavLink, Route, Routes } from "react-router-dom";
import { ConnectionBanner } from "./ConnectionBanner";
import { EnginePage } from "./pages/EnginePage";
import { InboundsPage } from "./pages/InboundsPage";
import { OutboundsPage } from "./pages/OutboundsPage";
import { PoolsPage } from "./pages/PoolsPage";
import { ChainsPage } from "./pages/ChainsPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { MetricsPage } from "./pages/MetricsPage";

export function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>goose</h1>
        <nav>
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/inbounds">Inbounds</NavLink>
          <NavLink to="/outbounds">Outbounds</NavLink>
          <NavLink to="/pools">Pools</NavLink>
          <NavLink to="/chains">Chains</NavLink>
          <NavLink to="/providers">Providers</NavLink>
          <NavLink to="/metrics">Metrics</NavLink>
        </nav>
      </aside>
      <main className="main">
        <ConnectionBanner />
        <Routes>
          <Route path="/" element={<EnginePage />} />
          <Route path="/inbounds" element={<InboundsPage />} />
          <Route path="/outbounds" element={<OutboundsPage />} />
          <Route path="/pools" element={<PoolsPage />} />
          <Route path="/chains" element={<ChainsPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
        </Routes>
      </main>
    </div>
  );
}
