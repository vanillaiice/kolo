import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import type { ShopService } from "../shared/service.ts";
import { applyAppearance, storedAppearance } from "./components/Settings.tsx";
// Inter ships inside the app, so text looks the same on every PC (and under Wine) and works offline.
import "@fontsource-variable/inter/wght.css";
import "./styles.css";

// This is the Electron composition root. DOM screens import only the replaceable service contract.
// Apply the saved appearance before the first paint so a chosen theme never flashes.
applyAppearance(storedAppearance());
const service: ShopService = window.kolo;
const element = document.getElementById("root");
if (element === null) throw new Error("missing application root");
createRoot(element).render(<App service={service} />);
