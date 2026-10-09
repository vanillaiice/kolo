import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import type { ShopService } from "../shared/service.ts";
import "./styles.css";

// This is the Electron composition root. DOM screens import only the replaceable service contract.
const service: ShopService = window.kolo;
const element = document.getElementById("root");
if (element === null) throw new Error("missing application root");
createRoot(element).render(<App service={service} />);
