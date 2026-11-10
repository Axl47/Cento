import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Screen } from "./Screen.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname === "/now" ? <Screen /> : <App />}
  </StrictMode>,
);
