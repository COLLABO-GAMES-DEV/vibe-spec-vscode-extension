import type { DocumentBlock, DocumentSnapshotBlock, ParsedDocument } from './document-types.js';
import { parseMarkdown } from './document-parser.js';
import { isRecord, VibeError } from './types.js';

export function checkMarkdownSource(source: unknown): asserts source is string {
  if (typeof source !== 'string') throw new VibeError('INVALID_ARGUMENT', 'Markdown source must be a string.');
  if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(source)) !== source) {
    throw new VibeError('INVALID_ARGUMENT', 'Markdown source must contain valid Unicode.');
  }
}

export interface SnapshotSource {
  source: string;
  /** Exact output ranges of reused blocks, including moves and repeated content. */
  unchanged: { block: DocumentBlock; start: number; end: number }[];
  removed: Set<number>;
}

/** Keep original gap slots; only block ranges and new-block separators are written. */
export function composeDocumentSnapshot(parsed: ParsedDocument, blocks: DocumentSnapshotBlock[]): SnapshotSource {
  if (!Array.isArray(blocks)) throw new VibeError('INVALID_ARGUMENT', 'Expected snapshot blocks.');
  const originals = new Set<number>();
  for (const block of blocks) {
    if (!isRecord(block) || Object.keys(block).some(key => !['original', 'markdown'].includes(key)) ||
        !Object.hasOwn(block, 'original') && !Object.hasOwn(block, 'markdown')) {
      throw new VibeError('INVALID_ARGUMENT', 'Expected original and/or markdown in a snapshot block.');
    }
    if (Object.hasOwn(block, 'original')) {
      if (typeof block.original !== 'number' || !Number.isInteger(block.original) || block.original < 0 || block.original >= parsed.blocks.length) {
        throw new VibeError('PATH_NOT_FOUND', 'Block index is outside this document revision.');
      }
      if (originals.has(block.original)) throw new VibeError('EDIT_OVERLAP', 'A snapshot cannot reuse an original block twice.');
      originals.add(block.original);
    }
    if (Object.hasOwn(block, 'markdown') || block.original === undefined) {
      checkMarkdownSource(block.markdown);
      if (block.original === undefined && !parseMarkdown(parsed.name, block.markdown).blocks.length) {
        throw new VibeError('INVALID_ARGUMENT', 'An inserted block cannot be empty.');
      }
    }
  }

  const result: SnapshotSource = { source: '', unchanged: [], removed: new Set() };
  let cursor = 0, desired = 0, hasContent = false;
  const append = (block: DocumentSnapshotBlock) => {
    const original = block.original === undefined ? undefined : parsed.blocks[block.original]!;
    const markdown = block.markdown ?? original!.markdown;
    const start = result.source.length;
    result.source += markdown;
    if (original && markdown === original.markdown) {
      result.unchanged.push({ block: original, start, end: result.source.length });
    }
    hasContent ||= markdown.length > 0;
  };
  for (const slot of parsed.blocks) {
    const gap = parsed.source.slice(cursor, slot.start);
    cursor = slot.end;
    if (!originals.has(slot.index)) {
      result.source += gap;
      result.removed.add(slot.index);
      continue;
    }
    // A moved block takes a surviving source slot, while whitespace stays put.
    // Put insertions before the slot's indentation so the original prefix survives.
    if (blocks[desired]?.original === undefined) {
      const padding = /[ \t]*$/.exec(gap)![0];
      result.source += gap.slice(0, gap.length - padding.length);
      if (hasContent) {
        const whitespace = /[ \t\r\n]*$/.exec(result.source)![0];
        const missing = Math.max(0, 2 - (whitespace.match(/\r\n|\r|\n/g)?.length ?? 0));
        // An LF immediately after a lone CR completes that newline instead of adding one.
        result.source += '\n'.repeat(missing + (missing && result.source.endsWith('\r') ? 1 : 0));
      }
      while (blocks[desired]?.original === undefined && desired < blocks.length) {
        append(blocks[desired++]!);
        result.source += '\n\n';
      }
      result.source += padding;
    } else result.source += gap;
    append(blocks[desired++]!);
  }
  // Appends precede the untouched original suffix, including its final newline.
  if (!parsed.blocks.length) {
    cursor = parsed.source.startsWith('\uFEFF') ? 1 : 0;
    result.source = parsed.source.slice(0, cursor);
  }
  while (desired < blocks.length) {
    if (hasContent) result.source += '\n\n';
    append(blocks[desired++]!);
  }
  result.source += parsed.source.slice(cursor);
  return result;
}
