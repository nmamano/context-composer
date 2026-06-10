import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const el = document.getElementById("root");
if (!el) throw new Error("ui: #root missing from index.html");
createRoot(el).render(<App />);
