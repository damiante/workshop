import type { TaskSummary, TaskView } from './api-types.ts';
import { all, one, run } from './db.ts';
import { publish } from './events.ts';
import { check } from './http/util.ts';
import { toView, VIEW_SQL, type ViewRow } from './runs.ts';
import { slugify } from './workflow/labels.ts';
import { TASK_AGENTS } from './workflow/prompts.ts';

/** A task: a virtual ticket outside the label workflow. Its runs point at it with `runs.task_id`. */
export interface TaskRow {
  id: number;
  repo_id: number;
  title: string;
  body: string;
  /** The branch every run on the task shares. */
  branch: string;
  /** A run pushed the branch with commits ahead of the base (0 or 1). */
  pushed: number;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
}

export const getTask = (id: number) => one<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);

const TITLE_MAX = 80;

/** A task's default title: the description's first non-empty line, shortened to 80 characters. */
export function taskTitle(body: string): string {
  const line = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

export const taskBranch = (id: number, title: string) => `workshop/task-${id}-${slugify(title)}`;

/** Where a design for the task lives: beside the branch name, as for tickets. */
export const taskDocPath = (task: Pick<TaskRow, 'branch'>) => `docs/workshop/${task.branch.replace(/^workshop\//, '')}.md`;

/** The task's active run, if an agent is working on it. */
export const activeTaskRunId = (taskId: number) =>
  one<{ id: string }>("SELECT id FROM runs WHERE task_id = ? AND status IN ('starting', 'running', 'publishing', 'paused')", taskId)?.id ?? null;

/** Marks the task changed, for the Tasks page's order, and tells browsers. */
export function touchTask(id: number | null) {
  if (id === null) return;
  run('UPDATE tasks SET updated_at = ? WHERE id = ?', Date.now(), id);
  publish('tasks');
}

export function createTask(p: { repoId: number; title: string; body: string }): TaskRow {
  const now = Date.now();
  const { lastInsertRowid } = run('INSERT INTO tasks (repo_id, title, body, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', p.repoId, p.title, p.body, '', now, now);
  const id = Number(lastInsertRowid);
  run('UPDATE tasks SET branch = ? WHERE id = ?', taskBranch(id, p.title), id);
  publish('tasks');
  return getTask(id)!;
}

export const deleteTask = (id: number) => {
  run('DELETE FROM tasks WHERE id = ?', id);
  publish('tasks');
};

export function setTaskClosed(id: number, closed: boolean) {
  const task = getTask(id);
  check(task, 'Task not found.', 404);
  if (closed === (task.closed_at !== null)) return;
  check(!closed || !activeTaskRunId(id), 'Stop the running agent before closing this task.', 409);
  const now = Date.now();
  run('UPDATE tasks SET closed_at = ?, updated_at = ? WHERE id = ?', closed ? now : null, now, id);
  publish('tasks');
}

type TaskListRow = TaskRow & { full_name: string; repo_url: string };

const TASK_SQL = 'SELECT tasks.*, repos.full_name, repos.url AS repo_url FROM tasks JOIN repos ON repos.id = tasks.repo_id';

function summary(t: TaskListRow, latest: ViewRow | undefined): Omit<TaskSummary, 'runs'> {
  return {
    id: t.id,
    repo: t.full_name,
    title: t.title,
    closed: t.closed_at !== null,
    branch: t.branch,
    branchUrl: t.pushed ? `${t.repo_url}/tree/${t.branch}` : null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    latest: latest ? toView(latest) : null,
  };
}

/** Every task: open ones first, then the most recently changed. */
export function taskViews(): TaskSummary[] {
  return all<TaskListRow>(`${TASK_SQL} ORDER BY tasks.closed_at IS NOT NULL, tasks.updated_at DESC, tasks.id DESC`).map((t) => {
    const latest = one<ViewRow>(`${VIEW_SQL} WHERE runs.task_id = ? ORDER BY runs.started_at DESC, runs.rowid DESC LIMIT 1`, t.id);
    const runs = one<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?', t.id)?.n ?? 0;
    return { ...summary(t, latest), runs };
  });
}

/** One task with every run on it, oldest first (not runViews: that's newest first and capped). */
export function taskView(id: number): TaskView | undefined {
  const t = one<TaskListRow>(`${TASK_SQL} WHERE tasks.id = ?`, id);
  if (!t) return undefined;
  const rows = all<ViewRow>(`${VIEW_SQL} WHERE runs.task_id = ? ORDER BY runs.started_at ASC, runs.rowid ASC`, id);
  return { ...summary(t, rows.at(-1)), body: t.body, runs: rows.map(toView), agents: TASK_AGENTS };
}
