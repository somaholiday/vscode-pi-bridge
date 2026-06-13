// Tests for pi IDE bridge shared state helpers.
// Keeps the Somaline handoff path stable across both extensions.

import { describe, expect, test } from "bun:test";
import { cwdHash, ideSnapshotPath, publicIdeSnapshot } from "./ide-bridge.js";

describe("ide-bridge shared state", () => {
  test("uses a cwd-keyed shared state snapshot path", () => {
    expect(cwdHash("/tmp/project")).toMatch(/^[0-9a-f]{16}$/);
    expect(ideSnapshotPath("/tmp/project")).toEndWith(`${cwdHash("/tmp/project")}.state.json`);
  });

  test("omits selected text from the public snapshot", () => {
    expect(publicIdeSnapshot({
      file: "src/x.ts",
      startLine: 3,
      endLine: 5,
      selectedText: "secret-ish code",
      languageId: "typescript",
    })).toEqual({
      file: "src/x.ts",
      startLine: 3,
      endLine: 5,
      languageId: "typescript",
    });
  });

});
