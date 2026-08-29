import { useState } from "react";

type TagSelectorProps = {
  name: string;
  label: string;
  suggestions: readonly string[];
  maxTags?: number;
};

export function TagSelector({ name, label, suggestions, maxTags = 12 }: TagSelectorProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [customOpen, setCustomOpen] = useState(false);
  const [customTag, setCustomTag] = useState("");

  function toggle(rawTag: string) {
    const tag = normalizeTag(rawTag);
    if (!tag) return;
    setSelected((current) =>
      current.includes(tag)
        ? current.filter((item) => item !== tag)
        : current.length < maxTags
          ? [...current, tag]
          : current,
    );
  }

  function addCustomTag() {
    const tag = normalizeTag(customTag);
    if (!tag) return;
    setSelected((current) => current.includes(tag) || current.length >= maxTags ? current : [...current, tag]);
    setCustomTag("");
    setCustomOpen(false);
  }

  const options = [...new Set([...suggestions.map(normalizeTag), ...selected])].filter(Boolean);

  return (
    <fieldset className="tag-selector span-two">
      <legend>{label}</legend>
      <div className="tag-selector-meta">
        <small>Select matching capabilities. Tags are normalized and deduplicated.</small>
        <strong>{selected.length} / {maxTags}</strong>
      </div>
      <div className="tag-chip-list">
        {options.map((tag) => (
          <button
            key={tag}
            type="button"
            className="tag-chip"
            aria-pressed={selected.includes(tag)}
            disabled={!selected.includes(tag) && selected.length >= maxTags}
            onClick={() => toggle(tag)}
          >
            {formatTag(tag)}
          </button>
        ))}
      </div>
      {selected.map((tag) => <input key={tag} type="hidden" name={name} value={tag} />)}
      {customOpen ? (
        <div className="tag-custom-row">
          <label>
            Custom tag
            <input
              autoFocus
              maxLength={48}
              value={customTag}
              onChange={(event) => setCustomTag(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addCustomTag();
                }
                if (event.key === "Escape") setCustomOpen(false);
              }}
            />
          </label>
          <button type="button" className="button button-ghost" onClick={addCustomTag}>Add</button>
          <button type="button" className="button button-ghost" onClick={() => setCustomOpen(false)}>Cancel</button>
        </div>
      ) : (
        <button type="button" className="tag-add-button" onClick={() => setCustomOpen(true)}>+ Add custom tag</button>
      )}
    </fieldset>
  );
}

export function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function formatTag(tag: string): string {
  return tag.split("-").map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : "").join(" ");
}
