// Run with: bun test web/src/lyrics
import { expect, test } from "bun:test";
import { toLines } from "./amll-lines.ts";

const syl = (Text: string, StartTime: number, EndTime: number, extra = {}) => ({
  Text,
  StartTime,
  EndTime,
  ...extra,
});

test("syllable lyrics: seconds to ms, word joins, background and duet lines", () => {
  const lines = toLines(
    {
      Type: "Syllable",
      Content: [
        {
          OppositeAligned: true,
          Lead: {
            StartTime: 1,
            EndTime: 3,
            Syllables: [
              syl("run", 1, 1.5, { IsPartOfWord: true, TransliteratedText: "RUN" }),
              syl("ning", 1.5, 2),
              syl("now", 2, 3),
            ],
          },
          Background: [{ StartTime: 2, EndTime: 3, Syllables: [syl("oh", 2, 3)] }],
        },
        // Nothing renderable: dropped rather than shown as an empty line.
        { Lead: { StartTime: 4, EndTime: 5, Syllables: [syl("  ", 4, 5)] } },
      ],
    },
    false
  );

  expect(lines).toHaveLength(2);
  const [lead, bg] = lines;
  // "run" + "ning" stay one word; the space only follows a finished word, and
  // never trails the line.
  expect(lead.words.map((w) => w.word)).toEqual(["run", "ning", " ", "now"]);
  expect(lead.words[0]).toMatchObject({ startTime: 1000, endTime: 1500, romanWord: "" });
  expect(lead).toMatchObject({ startTime: 1000, endTime: 3000, isBG: false, isDuet: true });
  expect(bg).toMatchObject({ startTime: 2000, isBG: true, isDuet: true });
});

test("romanization is carried next to the text, not instead of it", () => {
  const data = {
    Type: "Syllable",
    Content: [{ Lead: { StartTime: 0, EndTime: 1, Syllables: [syl("夜", 0, 1, { TransliteratedText: "yoru" })] } }],
  };
  expect(toLines(data, true)[0].words[0]).toMatchObject({ word: "夜", romanWord: "yoru" });

  const line = {
    Type: "Line",
    Content: [{ Text: "夜に駆ける", TransliteratedText: "yoru ni kakeru", StartTime: 2, EndTime: 4 }],
  };
  expect(toLines(line, true)[0]).toMatchObject({ romanLyric: "yoru ni kakeru", startTime: 2000, endTime: 4000 });
  expect(toLines(line, false)[0].romanLyric).toBe("");
});

test("an end before its start is clamped, since AMLL throws on it", () => {
  const [line] = toLines(
    { Type: "Line", Content: [{ Text: "oops", StartTime: 5, EndTime: 4 }] },
    false
  );
  expect(line.endTime).toBe(line.startTime);
  expect(line.words[0].endTime).toBe(line.words[0].startTime);
});

test("unsynced or malformed payloads give no lines", () => {
  expect(toLines({ Type: "Static", Lines: [{ Text: "a" }] }, false)).toEqual([]);
  expect(toLines({ Type: "Syllable" }, false)).toEqual([]);
  expect(toLines({ Type: "Syllable", Content: [{}, { Lead: {} }] }, false)).toEqual([]);
});
