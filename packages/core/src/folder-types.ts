export type FolderOperation =
  | { op: 'folder-create'; path: string }
  | { op: 'folder-rename'; path: string; name: string }
  | { op: 'folder-move'; path: string; folder: string }
  | { op: 'folder-delete'; path: string }
  | { op: 'resource-move'; kind: 'table' | 'document'; name: string; folder: string };
