"use client";

import { Search, Wrench, Youtube } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export type FlowsModalEntry = {
  category: string;
  description: string;
  icon: "workflow" | "youtube";
  id: string;
  run: () => void;
  selected: boolean;
  title: string;
};

export function workflowTitleGradient(title: string): string {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) >>> 0;
  }
  const startHue = hash % 360;
  const endHue = (startHue + 40 + (hash % 50)) % 360;
  return `linear-gradient(135deg, hsl(${startHue} 64% 48%) 0%, hsl(${endHue} 72% 26%) 100%)`;
}

/** The product's one Flows surface: search + category pills + blur-reveal
 * square grid. Canvas and the companion window both render this component so
 * the two never drift apart again. */
export function FlowsModal({
  categories,
  emptyLabel = "No flows available yet.",
  flows,
  onOpenChange,
  open,
}: {
  /** Filter pills; omit (or pass a single category) to hide the pill row. */
  categories?: string[];
  emptyLabel?: string;
  flows: FlowsModalEntry[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setFilter("All");
    }
  }
  const pills = categories && categories.length > 1 ? ["All", ...categories] : null;
  const visible = flows.filter(
    (flow) =>
      (!pills || filter === "All" || flow.category === filter) &&
      `${flow.title} ${flow.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workflow-modal" showClose={false}>
        <DialogTitle className="sr-only">Flows</DialogTitle>
        <div className="workflow-modal-search">
          <Search size={16} aria-hidden="true" />
          <input
            autoFocus
            className="workflow-modal-search-input"
            placeholder="Search flows..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {pills ? (
          <div className="workflow-modal-filters">
            {pills.map((category) => (
              <button
                key={category}
                type="button"
                className={`workflow-filter-pill ${filter === category ? "is-active" : ""}`}
                onClick={() => setFilter(category)}
              >
                {category}
              </button>
            ))}
          </div>
        ) : null}
        <div className="workflow-modal-grid">
          {visible.map((flow) => {
            const pickFlow = () => {
              flow.run();
              onOpenChange(false);
            };
            return (
              <div
                key={flow.id}
                role="button"
                tabIndex={0}
                aria-label={`${flow.title}. ${flow.description}`}
                aria-pressed={flow.selected}
                className="ref-card"
                title={flow.description}
                onClick={pickFlow}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    pickFlow();
                  }
                }}
              >
                {/* Title-derived gradient stands in until flows have real
                    representative media. */}
                <div
                  className="ref-thumb"
                  style={{ background: workflowTitleGradient(flow.title) }}
                >
                  <span className="ref-thumb-empty">{flow.title.charAt(0)}</span>
                  <div className="ref-card-gradient" aria-hidden="true" />
                  <div className="ref-card-blur" aria-hidden="true">
                    {[1, 2, 3, 4].map((layer) => (
                      <span key={layer} />
                    ))}
                  </div>
                  <div className="ref-card-content">
                    <span className="ref-card-icon" aria-hidden="true">
                      {flow.icon === "youtube" ? <Youtube size={16} /> : <Wrench size={16} />}
                    </span>
                    <div className="ref-card-copy">
                      <span className="ref-name">{flow.title}</span>
                      <span className="ref-sub">
                        {flow.selected ? "Selected" : flow.description}
                      </span>
                    </div>
                    <div className="ref-card-actions">
                      <button
                        className="ref-card-view-button"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          pickFlow();
                        }}
                      >
                        {flow.selected
                          ? "✓ Selected"
                          : flow.category === "Workflows"
                            ? "Use workflow"
                            : "Use"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {!visible.length ? (
            <p className="workflow-modal-empty">{emptyLabel}</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
