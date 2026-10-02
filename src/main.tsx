import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { SdkProvider } from "./sdk";
import { App } from "./App";
import "./palette.css";
import "./styles.css";

// The app element carries the viz-root class so the palette custom
// properties (light + dark) scope the whole UI, not just the charts.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SdkProvider>
        <App />
      </SdkProvider>
    </BrowserRouter>
  </StrictMode>,
);
