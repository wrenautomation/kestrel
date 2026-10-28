import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/base.css";
import "./style.css";
import { App } from "./App";

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
