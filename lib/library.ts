import { listOwnedPublishedItems, type PublishedItemSummary } from "@/lib/published-items";
import { createServerClient } from "@/lib/supabase";

export type LibraryFolder = {
  createdAt: string;
  id: string;
  name: string;
  parentFolderId: string | null;
  position: number;
};

export type LibraryItemPlacement = {
  folderId: string;
  itemId: string;
};

export type LibraryTree = {
  folders: LibraryFolder[];
  items: PublishedItemSummary[];
  placements: LibraryItemPlacement[];
};

type FolderRow = {
  created_at: string;
  id: string;
  name: string;
  parent_folder_id: string | null;
  position: number;
};

const FOLDER_COLUMNS = "id,parent_folder_id,name,position,created_at";

function normalizeFolder(row: FolderRow): LibraryFolder {
  return {
    createdAt: row.created_at,
    id: row.id,
    name: row.name,
    parentFolderId: row.parent_folder_id,
    position: row.position,
  };
}

async function assertFolderOwned(
  supabase: ReturnType<typeof createServerClient>,
  ownerUserId: string,
  folderId: string,
) {
  const { data, error } = await supabase
    .from("library_folders")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .eq("id", folderId)
    .maybeSingle();
  if (error) throw new Error(`Failed to verify folder: ${error.message}`);
  if (!data) throw new Error("Folder not found.");
}

export async function listLibraryFolders(ownerUserId: string): Promise<LibraryFolder[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("library_folders")
    .select(FOLDER_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to read library folders: ${error.message}`);
  return ((data ?? []) as FolderRow[]).map(normalizeFolder);
}

export async function listItemPlacements(ownerUserId: string): Promise<LibraryItemPlacement[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("library_item_placements")
    .select("item_id,folder_id")
    .eq("owner_user_id", ownerUserId);
  if (error) throw new Error(`Failed to read library placements: ${error.message}`);
  return ((data ?? []) as Array<{ folder_id: string; item_id: string }>).map((row) => ({
    folderId: row.folder_id,
    itemId: row.item_id,
  }));
}

export async function loadLibraryTree(ownerUserId: string): Promise<LibraryTree> {
  const [folders, items, placements] = await Promise.all([
    listLibraryFolders(ownerUserId),
    listOwnedPublishedItems({ currentUserId: ownerUserId, limit: 1000 }),
    listItemPlacements(ownerUserId),
  ]);
  return { folders, items, placements };
}

export async function createLibraryFolder(input: {
  name: string;
  ownerUserId: string;
  parentFolderId?: string | null;
}): Promise<LibraryFolder> {
  const supabase = createServerClient();
  const name = input.name.trim();
  if (!name) throw new Error("Folder name is required.");
  const parentFolderId = input.parentFolderId ?? null;
  if (parentFolderId) await assertFolderOwned(supabase, input.ownerUserId, parentFolderId);

  const { data, error } = await supabase
    .from("library_folders")
    .insert({ name, owner_user_id: input.ownerUserId, parent_folder_id: parentFolderId })
    .select(FOLDER_COLUMNS)
    .single();
  if (error) throw new Error(`Failed to create folder: ${error.message}`);
  return normalizeFolder(data as FolderRow);
}

export async function renameLibraryFolder(input: {
  folderId: string;
  name: string;
  ownerUserId: string;
}): Promise<LibraryFolder> {
  const supabase = createServerClient();
  const name = input.name.trim();
  if (!name) throw new Error("Folder name is required.");

  const { data, error } = await supabase
    .from("library_folders")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("owner_user_id", input.ownerUserId)
    .eq("id", input.folderId)
    .select(FOLDER_COLUMNS)
    .single();
  if (error) throw new Error(`Failed to rename folder: ${error.message}`);
  return normalizeFolder(data as FolderRow);
}

export async function deleteLibraryFolder(input: {
  folderId: string;
  ownerUserId: string;
}): Promise<void> {
  const supabase = createServerClient();
  const { error } = await supabase
    .from("library_folders")
    .delete()
    .eq("owner_user_id", input.ownerUserId)
    .eq("id", input.folderId);
  if (error) throw new Error(`Failed to delete folder: ${error.message}`);
}

export async function moveLibraryFolder(input: {
  folderId: string;
  ownerUserId: string;
  parentFolderId: string | null;
}): Promise<LibraryFolder> {
  const supabase = createServerClient();
  const parentFolderId = input.parentFolderId ?? null;
  if (parentFolderId === input.folderId) {
    throw new Error("A folder cannot be moved into itself.");
  }
  if (parentFolderId) {
    // Cycle guard: the new parent must not be the folder or one of its descendants.
    const folders = await listLibraryFolders(input.ownerUserId);
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    let cursor: string | null = parentFolderId;
    while (cursor) {
      if (cursor === input.folderId) {
        throw new Error("A folder cannot be moved into its own descendant.");
      }
      cursor = byId.get(cursor)?.parentFolderId ?? null;
    }
  }

  const { data, error } = await supabase
    .from("library_folders")
    .update({ parent_folder_id: parentFolderId, updated_at: new Date().toISOString() })
    .eq("owner_user_id", input.ownerUserId)
    .eq("id", input.folderId)
    .select(FOLDER_COLUMNS)
    .single();
  if (error) throw new Error(`Failed to move folder: ${error.message}`);
  return normalizeFolder(data as FolderRow);
}

export async function deleteOwnedItem(input: {
  itemId: string;
  ownerUserId: string;
}): Promise<void> {
  const supabase = createServerClient();
  const { error } = await supabase
    .from("published_items")
    .delete()
    .eq("publisher_id", input.ownerUserId)
    .eq("id", input.itemId);
  if (error) throw new Error(`Failed to delete item: ${error.message}`);
}

export async function setItemPlacement(input: {
  folderId: string | null;
  itemId: string;
  ownerUserId: string;
}): Promise<void> {
  const supabase = createServerClient();
  if (!input.folderId) {
    const { error } = await supabase
      .from("library_item_placements")
      .delete()
      .eq("owner_user_id", input.ownerUserId)
      .eq("item_id", input.itemId);
    if (error) throw new Error(`Failed to move item to root: ${error.message}`);
    return;
  }

  await assertFolderOwned(supabase, input.ownerUserId, input.folderId);
  const { error } = await supabase
    .from("library_item_placements")
    .upsert(
      {
        folder_id: input.folderId,
        item_id: input.itemId,
        owner_user_id: input.ownerUserId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "item_id" },
    );
  if (error) throw new Error(`Failed to move item: ${error.message}`);
}
