import { BlockNoteSchema, createHeadingBlockSpec, defaultBlockSpecs, defaultStyleSpecs, type BlockSpec } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';
import { rawMarkdownText } from './documentEditorAdapter';

// Unsupported Markdown is an ordinary draggable/deletable BlockNote block. Its
// source lives in a JSON-escaped prop so native HTML drag transport cannot
// normalize its CRLF bytes. It is never executable HTML or lossy Markdown.
const rawMarkdown = createReactBlockSpec({ type: 'rawMarkdown', propSchema: { markdown: { default: '""' } }, content: 'none' }, {
  render: ({ block, editor }) => <div className="document-raw-block" contentEditable={false}>
    <textarea aria-label="원문 Markdown" spellCheck={false} value={rawMarkdownText(block.props.markdown)}
      onKeyDown={event => { if (!(event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey))) event.stopPropagation(); }}
      readOnly={!editor.isEditable} rows={Math.max(2, rawMarkdownText(block.props.markdown).split('\n').length)}
      onChange={event => { if (editor.isEditable) editor.updateBlock(block, { props: { markdown: JSON.stringify(event.target.value) } }); }} />
  </div>,
})();
type HeadingProps = Omit<ReturnType<typeof createHeadingBlockSpec>['config']['propSchema'], 'isToggleable'>;
const heading = createHeadingBlockSpec({ levels: [1, 2, 3, 4, 5, 6], allowToggleHeadings: false }) as BlockSpec<'heading', HeadingProps, 'inline'>;
export const documentEditorSchema = BlockNoteSchema.create({ blockSpecs: {
  paragraph: defaultBlockSpecs.paragraph, heading,
  bulletListItem: defaultBlockSpecs.bulletListItem, numberedListItem: defaultBlockSpecs.numberedListItem,
  checkListItem: defaultBlockSpecs.checkListItem, quote: defaultBlockSpecs.quote,
  codeBlock: defaultBlockSpecs.codeBlock, table: defaultBlockSpecs.table,
  image: defaultBlockSpecs.image, divider: defaultBlockSpecs.divider, rawMarkdown,
}, styleSpecs: { bold: defaultStyleSpecs.bold, italic: defaultStyleSpecs.italic,
  strike: defaultStyleSpecs.strike, code: defaultStyleSpecs.code } });
export type EditorBlock = typeof documentEditorSchema.Block;
