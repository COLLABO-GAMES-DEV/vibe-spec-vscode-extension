import type { DocumentBlock, DocumentSnapshotBlock, DocumentView } from '@vibe-spec/core';

export type SourceBlock = { id: string; type: string; props: Record<string, unknown>; content?: unknown; children: SourceBlock[] };
// IDs are session-local bookkeeping. Content signatures never persist them.
export const contentIdentity = (value: unknown): string => JSON.stringify(value, (key, item: unknown) => key === 'id' ? undefined : item);
export const rawMarkdownText = (encoded: unknown): string => {
  const value: unknown = JSON.parse(String(encoded));
  if (typeof value !== 'string') throw new Error('원문 블록의 내용을 읽을 수 없습니다.');
  return value;
};
type Group<B> = { source: DocumentBlock; prefix: string; members: B[] };
export class DocumentEditorAdapter<B extends SourceBlock> {
  private groups: Group<B>[] = [];
  private baseline = '';
  private emptyId: string | undefined;
  constructor(private parse: (markdown: string) => B[], private raw: (markdown: string) => B,
    private serialize: (blocks: B[]) => string) {}

  prepare(view: DocumentView): B[] {
    this.groups = view.blocks.map(source => {
      const prefix = source.kind === 'paragraph' && source.path
        ? /^(<!--[ \t]*name:[^\r\n]*-->)(?:\r\n|\r|\n)[ \t]*/.exec(source.markdown)?.[0] ?? '' : '';
      let members: B[];
      try { members = source.editable ? this.parse(source.markdown.slice(prefix.length)) : [this.raw(source.markdown)]; }
      catch { members = [this.raw(source.markdown)]; }
      if (!members.length) members = [this.raw(source.markdown)];
      return { source, prefix: members[0]?.type === 'rawMarkdown' ? '' : prefix, members };
    });
    return this.groups.flatMap(group => group.members);
  }

  capture(blocks: B[]): void {
    // Read normalized editor output after initial insertion, preserving root IDs.
    const byId = new Map(blocks.map(block => [block.id, block]));
    for (const group of this.groups) group.members = group.members.map(member => byId.get(member.id) ?? member);
    this.emptyId = this.groups.length === 0 && blocks.length === 1 ? blocks[0]!.id : undefined;
    this.baseline = this.identity(blocks);
  }
  private identity(blocks: B[]): string {
    return JSON.stringify(blocks.map(block => [block.id, contentIdentity(block)]));
  }
  dirty(blocks: B[]): boolean { return this.identity(blocks) !== this.baseline; }
  private isEmpty(block: B): boolean {
    return block.type === 'paragraph' && Array.isArray(block.content) && block.content.length === 0 && block.children.length === 0;
  }
  snapshot(blocks: B[]): DocumentSnapshotBlock[] {
    if (blocks.length === 1 && this.isEmpty(blocks[0]!) && (this.emptyId || !this.groups.some(g => g.members.some(b => b.id === blocks[0]!.id)))) return [];
    const owner = new Map(this.groups.flatMap(group => group.members.map(member => [member.id, group] as const)));
    const rootIds = new Set(blocks.map(block => block.id));
    const allIds = (items: SourceBlock[]): string[] => items.flatMap(item => [item.id, ...allIds(item.children)]);
    const present = new Set(allIds(blocks));
    for (const group of this.groups.filter(item => item.prefix)) {
      const member = blocks.find(item => item.id === group.members[0]?.id);
      if (group.members.some(item => present.has(item.id) && !rootIds.has(item.id)) ||
        member && (member.type !== 'paragraph' && member.type !== 'image' || this.isEmpty(member))) {
        throw new Error('주소가 있는 문단은 본문이 있는 최상위 문단으로 유지해 주세요. 초안은 보존됩니다.');
      }
    }
    const used = new Set<Group<B>>();
    const result: DocumentSnapshotBlock[] = [];
    for (let index = 0; index < blocks.length;) {
      const block = blocks[index]!;
      const group = owner.get(block.id);
      const family = (item: B) => item.type === 'numberedListItem' ? 'ordered' :
        /^(bulletListItem|checkListItem)$/.test(item.type) ? 'unordered' : item.type === 'quote' ? 'quote' : '';
      // Native editing can merge two formerly separate lists/quotes or add a
      // member. Export the entire affected contiguous group so core does not
      // mistake an absorbed old group for an unchanged source boundary.
      if (family(block)) {
        const run: B[] = [];
        while (index < blocks.length && family(blocks[index]!) === family(block)) run.push(blocks[index++]!);
        const owners = [...new Set(run.map(member => owner.get(member.id)).filter((item): item is Group<B> => Boolean(item)))];
        const originals = owners.flatMap(item => item.members);
        const unchangedAdjacency = owners.every((item, i) => !used.has(item) &&
          (i === 0 || item.source.index === owners[i - 1]!.source.index + 1));
        const sameBoundaries = unchangedAdjacency && run.length === originals.length && run.every((member, i) =>
          member.id === originals[i]!.id && member.type === originals[i]!.type);
        if (sameBoundaries) {
          // Different Markdown markers can form adjacent source lists even
          // though BlockNote exposes all their members as sibling list items.
          let offset = 0;
          for (const item of owners) {
            const members = run.slice(offset, offset + item.members.length);
            offset += item.members.length;
            result.push(contentIdentity(members) === contentIdentity(item.members) ? { original: item.source.index } :
              { original: item.source.index, markdown: this.groupMarkdown(item, members) });
          }
        } else {
          const first = owners.find(item => !used.has(item));
          result.push({ ...(first ? { original: first.source.index } : {}), markdown: this.markdown(run) });
        }
        owners.forEach(item => used.add(item));
        continue;
      }
      if (!group) {
        // Empty native paragraphs are insertion points, not Markdown blocks.
        if (!this.isEmpty(block)) result.push({ markdown: this.markdown([block]) });
        index++; continue;
      }
      const run: B[] = [];
      while (index < blocks.length && owner.get(blocks[index]!.id) === group) run.push(blocks[index++]!);
      const first = !used.has(group);
      used.add(group);
      const intact = first && run.length === group.members.length && run.every((member, i) =>
        member.id === group.members[i]!.id && contentIdentity(member) === contentIdentity(group.members[i]));
      result.push(intact ? { original: group.source.index } : {
        ...(first ? { original: group.source.index } : {}), markdown: (first ? group.prefix : '') + this.markdown(run),
      });
    }
    return result;
  }
  private groupMarkdown(group: Group<B>, blocks: B[]): string {
    let markdown = this.markdown(blocks);
    if (group.source.kind === 'list') {
      // Preserve the top-level marker of a known source list. Otherwise the
      // serializer's default '*' could absorb an unchanged adjacent '*' list.
      // Nested list/code lines are indented and are intentionally not changed.
      const bullet = /^([-+*])[ \t]/.exec(group.source.markdown)?.[1];
      const ordered = /^\d+([.)])[ \t]/.exec(group.source.markdown)?.[1];
      if (bullet) markdown = markdown.replace(/^[-+*](?=[ \t])/gm, bullet);
      if (ordered) markdown = markdown.replace(/^(\d+)[.)](?=[ \t])/gm, '$1' + ordered);
    }
    return group.prefix + markdown;
  }
  private markdown(blocks: B[]): string {
    // Raw blocks are never sent through BlockNote's lossy serializer, including
    // when a user nests one under another block using the native side menu.
    if (blocks.some(block => this.hasRaw(block))) return blocks.map(block => {
      if (block.type === 'rawMarkdown') {
        if (block.children.length) throw new Error('원문 블록의 하위 블록을 밖으로 이동한 뒤 저장해 주세요.');
        return rawMarkdownText(block.props.markdown);
      }
      if (block.children.some(child => this.hasRaw(child))) throw new Error('중첩된 원문 블록을 밖으로 이동한 뒤 저장해 주세요.');
      return this.serialize([block]);
    }).join('\n\n');
    return this.serialize(blocks);
  }
  private hasRaw(block: SourceBlock): boolean { return block.type === 'rawMarkdown' || block.children.some(child => this.hasRaw(child)); }

  /** Bind fresh offsets to the existing editor when the saved semantic body agrees. */
  rebaseline(view: DocumentView, current: B[]): B[] | undefined {
    const fresh = this.prepare(view);
    // Empty insertion paragraphs have no Markdown source block. Keep their
    // native IDs, selection and undo history while rebinding only stored roots.
    const actual = current.filter(block => !this.isEmpty(block));
    if (contentIdentity(fresh) !== contentIdentity(actual)) return fresh;
    let offset = 0;
    for (const group of this.groups) {
      group.members = actual.slice(offset, offset + group.members.length);
      offset += group.members.length;
    }
    this.capture(current);
    return undefined;
  }
  firstHeading(blocks: B[]): boolean { return blocks.some(block => block.type === 'heading' && block.props.level === 1); }
  pathId(path: string): string | undefined { return this.groups.find(group => group.source.path === path)?.members[0]?.id; }
}
