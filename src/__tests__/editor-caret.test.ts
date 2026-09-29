// src/__tests__/editor-caret.test.ts
//
// `←` at the very start of the prompt opens the Task Monitor. The caret is read
// from pi's own editor via getFocusedComponent() + Editor.getCursor(), so these
// cover the shapes that reach us: the editor, something else focused, nothing
// focused, and a TUI that isn't there yet.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { caretAtPromptStart } from "../editor-caret.ts";

const tuiWith = (focused: unknown) => ({ getFocusedComponent: () => focused });
const editorAt = (line: number, col: number) => ({ getCursor: () => ({ line, col }) });

describe("caretAtPromptStart", () => {
    test("true only at line 0, col 0", () => {
        assert.equal(caretAtPromptStart(tuiWith(editorAt(0, 0))), true);
        assert.equal(caretAtPromptStart(tuiWith(editorAt(0, 1))), false);
        assert.equal(caretAtPromptStart(tuiWith(editorAt(1, 0))), false);
        assert.equal(caretAtPromptStart(tuiWith(editorAt(2, 7))), false);
    });

    test("false when the prompt editor is not the focused component", () => {
        // A modal/overlay/dialog holds focus: no getCursor, so `←` must pass
        // through instead of being hijacked.
        assert.equal(caretAtPromptStart(tuiWith({ render: () => [] })), false);
        assert.equal(caretAtPromptStart(tuiWith(null)), false);
        assert.equal(caretAtPromptStart(undefined), false);
    });

    test("false when the TUI cannot report focus at all", () => {
        assert.equal(caretAtPromptStart({}), false);
    });
});
