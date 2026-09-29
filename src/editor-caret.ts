/**
 * Read the prompt's caret out of pi's own editor.
 *
 * There is no cursor accessor on the extension UI context (`getEditorText` /
 * `setEditorText` only), but the editor itself exposes it publicly: the default
 * prompt editor is `CustomEditor extends Editor`, pi focuses that instance
 * directly, and `Editor.getCursor()` returns `{ line, col }`. So the caret is
 * reachable without subclassing `CustomEditor`, without touching private fields,
 * and without replacing pi's editor.
 *
 * Returns false whenever the focused component is NOT the prompt editor (a modal
 * or dialog is up, focus is elsewhere, or the TUI is unavailable) — which is what
 * keeps a `←` binding from hijacking input that belongs to something else.
 */

interface CaretReader {
    getCursor?(): { line: number; col: number };
}

/** Minimal shape of the pi-tui TUI we need. */
export interface CaretSource {
    getFocusedComponent?(): unknown;
}

/** True when the caret sits at the very start of the prompt. */
export function caretAtPromptStart(tui: CaretSource | undefined): boolean {
    const focused = tui?.getFocusedComponent?.() as CaretReader | null | undefined;
    const caret = focused?.getCursor?.();
    return caret?.line === 0 && caret?.col === 0;
}
