import { useEffect, useState } from "react";
import type { ViewData } from "../../src/view/types";
import { Dialog } from "./Dialog";

interface Props {
  data: ViewData;
  about: string;
  onClose(): void;
}

const LAST = "kestrel.note.to";
const recall = () => {
  try {
    return localStorage.getItem(LAST) ?? "";
  } catch {
    return "";
  }
};

/** A note to a Claude Code session, through Devboard: the box, the link, the text. */
export function Note({ data, about, onClose }: Props) {
  const [text, setText] = useState("");
  const [to, setTo] = useState(recall);
  const [watchers, setWatchers] = useState<string[]>([]);
  const [state, setState] = useState<string>();
  useEffect(() => {
    fetch("./api/watchers")
      .then((r) => r.json())
      .then((j: { watchers?: string[] }) => setWatchers(j.watchers ?? []))
      .catch(() => setState("Devboard is not reachable, so notes cannot go out."));
  }, []);
  const send = async () => {
    if (!text.trim()) return;
    setState("Sending…");
    try {
      localStorage.setItem(LAST, to);
    } catch {
      /* private window */
    }
    const r = await fetch("./api/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to,
        text: `[kestrel ${data.repo}] ${about}: ${text.trim()}`,
        ids: [],
        link: location.href,
      }),
    }).then((x) => x.json() as Promise<{ success?: boolean; reached?: number; error?: string }>);
    if (!r.success) return setState(r.error ?? "Not sent.");
    setState(r.reached ? "Sent." : "Saved. No session is listening under that name now.");
    setTimeout(onClose, 700);
  };
  return (
    <Dialog className="note" onClose={onClose}>
      <div className="inner">
        <h3>Note on {data.nodes[about]?.label ?? about}</h3>
        <textarea
          rows={4}
          value={text}
          placeholder="What should change, or what is unclear"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
        <div className="row">
          <label>
            To{" "}
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">every session</option>
              {watchers.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary" onClick={() => void send()}>
            Send <kbd>⌘ Enter</kbd>
          </button>
        </div>
        {state && <p className="meta">{state}</p>}
      </div>
    </Dialog>
  );
}
