import type { DatabaseSync } from "node:sqlite";

export class ProjectMapper {
  constructor(private readonly database: DatabaseSync) {}

  findIdByWorkspacePath(workspacePath: string): string | undefined {
    const row = this.database
      .prepare("SELECT id FROM projects WHERE workspace_path = ?")
      .get(workspacePath) as { id: string } | undefined;
    return row?.id;
  }

  updateTitle(id: string, title: string, updatedAt: string): void {
    this.database
      .prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, updatedAt, id);
  }

  insert(id: string, workspacePath: string, title: string, now: string): void {
    this.database
      .prepare(`
      INSERT INTO projects(id, workspace_path, title, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?)
    `)
      .run(id, workspacePath, title, now, now);
  }
}
