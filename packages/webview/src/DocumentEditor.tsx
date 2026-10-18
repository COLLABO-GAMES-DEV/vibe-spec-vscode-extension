import { useEffect, useRef, useState, type RefObject } from 'react';
import { filterSuggestionItems, getDefaultSlashMenuItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { ko } from '@blocknote/core/locales';
import { BlockNoteView } from '@blocknote/mantine';
import { BasicTextStyleButton, BlockTypeSelect, CreateLinkButton, FormattingToolbar, FormattingToolbarController,
  SuggestionMenuController, SideMenuController, SideMenu, DragHandleMenu, RemoveBlockItem, useCreateBlockNote } from '@blocknote/react';
import type { DocumentSnapshotBlock, DocumentView } from '@vibe-spec/core';
import { documentEditorSchema as schema, type EditorBlock } from './documentEditorSchema';
import { DocumentEditorAdapter } from './documentEditorAdapter';
import '@blocknote/mantine/style.css';

export type DocumentEditorHandle = { snapshot: () => { dirty: boolean; blocks: DocumentSnapshotBlock[] }; unlock: () => void };
export function assetUrl(path: string, assets: Record<string, string>): string {
  if (Object.hasOwn(assets, path)) return assets[path]!;
  try { const decoded = decodeURIComponent(path).replace(/^\.\//, ''); return Object.hasOwn(assets, decoded) ? assets[decoded]! : ''; }
  catch { return ''; }
}
const slashTypes = new Set(['heading', 'heading_2', 'heading_3', 'heading_4', 'heading_5', 'heading_6',
  'paragraph', 'bullet_list', 'numbered_list', 'check_list', 'quote', 'code_block', 'table', 'divider', 'image']);
function MarkdownToolbar() {
  return <FormattingToolbar><BlockTypeSelect />
    <BasicTextStyleButton basicTextStyle="bold" /><BasicTextStyleButton basicTextStyle="italic" />
    <BasicTextStyleButton basicTextStyle="strike" /><BasicTextStyleButton basicTextStyle="code" /><CreateLinkButton />
  </FormattingToolbar>;
}
export function DocumentEditor({ view, assets, disabled, focusPath, handleRef, onChange, onError, uploadImage, navigate }: {
  view: DocumentView; assets: Record<string, string>; disabled: boolean; focusPath?: string | undefined;
  handleRef: RefObject<DocumentEditorHandle | undefined>;
  onChange: (dirty: boolean, firstHeading: boolean) => void; onError: (message: string) => void;
  uploadImage: (file: File) => Promise<string>; navigate: (path: string) => void;
}) {
  const callbacks = useRef({ assets, onChange, onError, uploadImage, navigate });
  callbacks.current = { assets, onChange, onError, uploadImage, navigate };
  const [loaded, setLoaded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const locked = useRef(false);
  const editor = useCreateBlockNote({ schema, dictionary: ko,
    domAttributes: { editor: { 'aria-label': '문서 편집', 'data-testid': 'document-rich-editor' } },
    tables: { splitCells: false, cellBackgroundColor: false, cellTextColor: false, headers: false },
    resolveFileUrl: async url => assetUrl(url, callbacks.current.assets),
    links: { onClick: event => {
      event.preventDefault();
      const href = (event.target as Element).closest('a')?.getAttribute('href');
      if (href) callbacks.current.navigate(href);
      return true;
    } },
    pasteHandler: ({ event, editor: target }) => {
      const text = event.clipboardData?.getData('text/plain');
      if (text) target.pasteText(text);
      return true;
    },
  });
  const adapter = useRef<DocumentEditorAdapter<EditorBlock> | undefined>(undefined);
  const baseline = useRef<DocumentView | undefined>(undefined);
  const syncing = useRef(false);
  useEffect(() => {
    const source = new DocumentEditorAdapter<EditorBlock>(markdown => editor.tryParseMarkdownToBlocks(markdown.replace(/\r\n?/g, '\n')),
      markdown => ({ id: crypto.randomUUID(), type: 'rawMarkdown', props: { markdown: JSON.stringify(markdown) }, children: [], content: undefined }),
      // Source gaps belong to core; serializer terminators must not accumulate there.
      blocks => editor.blocksToMarkdownLossy(blocks).replace(/\n+$/, ''));
    adapter.current = source;
    const notify = () => callbacks.current.onChange(source.dirty(editor.document), source.firstHeading(editor.document));
    try {
      const blocks = source.prepare(view);
      editor.transact(transaction => {
        transaction.setMeta('addToHistory', false);
        editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph', content: '' }]);
      });
      source.capture(editor.document);
      baseline.current = view;
      setLoaded(true);
      notify();
    } catch (error) { callbacks.current.onError(String(error)); }
    const off = editor.onChange(() => { if (!syncing.current) notify(); });
    handleRef.current = {
      snapshot: () => {
        if (!baseline.current) throw new Error('편집기를 준비하고 있습니다. 잠시 후 다시 저장해 주세요.');
        if (composing.current) throw new Error('한글 입력을 마친 뒤 다시 저장해 주세요.');
        locked.current = true;
        editor.isEditable = false;
        try { return { dirty: source.dirty(editor.document), blocks: source.snapshot(editor.document) }; }
        catch (error) { locked.current = false; editor.isEditable = true; throw error; }
      },
      unlock: () => { locked.current = false; },
    };
    return () => { off(); handleRef.current = undefined; };
    // This initializes once per document; subsequent source revisions rebaseline below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  useEffect(() => {
    if (baseline.current === view || !adapter.current || !loaded) return;
    syncing.current = true;
    try {
      const replacement = adapter.current.rebaseline(view, editor.document);
      if (replacement) {
        editor.replaceBlocks(editor.document, replacement.length ? replacement : [{ type: 'paragraph', content: '' }]);
        adapter.current.capture(editor.document);
      }
      baseline.current = view;
      callbacks.current.onChange(false, adapter.current.firstHeading(editor.document));
    } catch (error) { callbacks.current.onError(String(error)); }
    finally { syncing.current = false; }
  }, [view, editor, loaded]);
  useEffect(() => {
    editor.isEditable = loaded && !disabled && !locked.current;
  }, [editor, loaded, disabled]);
  useEffect(() => {
    if (!focusPath || !loaded) return;
    const id = adapter.current?.pathId(focusPath);
    if (id) { editor.setTextCursorPosition(id, 'start'); editor.domElement?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' }); }
  }, [focusPath, loaded, editor]);
  useEffect(() => {
    const cancel = () => editor.focus();
    const element = input.current;
    element?.addEventListener('cancel', cancel);
    return () => element?.removeEventListener('cancel', cancel);
  }, [editor]);
  return <div className="document-rich" data-testid="document-editor"
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <input ref={input} type="file" aria-label="문서 이미지 파일" accept="image/png,image/jpeg,image/gif,image/webp" hidden
      onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file) { editor.focus(); return; }
        try {
          const url = await callbacks.current.uploadImage(file);
          insertOrUpdateBlockForSlashMenu(editor, { type: 'image', props: { url: url.split('/').map(encodeURIComponent).join('/'), name: file.name } });
        } catch (error) { callbacks.current.onError(String(error)); }
        finally { editor.focus(); }
      }} />
    {!loaded && <p role="status">편집기를 준비하고 있습니다.</p>}
    <BlockNoteView editor={editor} editable={loaded && !disabled} formattingToolbar={false} slashMenu={false}
      sideMenu={false} filePanel={false} emojiPicker={false} linkToolbar={false}>
      <SideMenuController sideMenu={props => <SideMenu {...props} dragHandleMenu={() =>
        <DragHandleMenu><RemoveBlockItem>삭제</RemoveBlockItem></DragHandleMenu>} />} />
      <FormattingToolbarController formattingToolbar={MarkdownToolbar} />
      <SuggestionMenuController triggerCharacter="/" getItems={async query =>
        filterSuggestionItems(getDefaultSlashMenuItems(editor).filter(item => slashTypes.has(item.key)).map(item =>
          item.key === 'image' ? { ...item, onItemClick: () => input.current?.click() } : item), query)} />
    </BlockNoteView>
  </div>;
}
