import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./app/app.css";
import { detectPlatform } from "./core/platform";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support for the installed web app. Not for `npm run dev`, and not inside the desktop shell.
if ("serviceWorker" in navigator && import.meta.env.PROD && detectPlatform() === "web") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
