# Synthetic import fixtures

`items.csv` and `items.xlsx` contain the same 145 invented items. They contain no
exported game data or private source metadata. Tests run offline.

Both files retain an empty first row and first column, `Key / Source / Lore / Note`
at B2:E2, and data starting at B3. The XLSX sheet is named `Synthetic Items`.

| Cell | Synthetic text |
| --- | --- |
| B3 | `sample_item_001` |
| C3 | `합성 아이템 001` |
| B145 | `sample_item_143` |
| C145 | `합성 아이템 143` |
| D145 | `합성 설명 143입니다.` |
| B147 | `sample_item_145` |

D6 has a trailing space. E13 has quotes, a comma, leading/trailing spaces and a
line break. Other Note cells are empty. CSV record separators are CRLF; quoting
preserves the embedded LF. Every populated XLSX cell is a string, including Keys.
These coordinates describe test fixtures, not a fixed import layout.

`import-reader.test.ts` separately builds cases for different header positions,
internal blanks, duplicate headers/Keys, hidden rows/columns/sheets, merged cells,
formulas, dates, error cells and formatting warnings. Those cases are retained.
Numeric cases inject literal strings directly into worksheet XML in a ZIP, so
large integers, decimal digits, signed zero, trailing zeros and exponent spelling
never pass through JavaScript numbers before inspection.
